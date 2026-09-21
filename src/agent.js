// Core agent loop. Manages conversation history, parses model output, executes tools, feeds results back.
// Max 20 iterations with retry on parse failure.
// Tracks task state to prevent premature final responses.

import { chat as defaultChat } from "./llm.js";
import { buildSystemPrompt } from "./context.js";
import {
  executeToolCall as defaultExecuteToolCall,
  parseModelOutput,
  formatToolResult,
} from "./tools.js";
import { createPlan as defaultCreatePlan } from "./planner.js";

const SYSTEM_PROMPT = buildSystemPrompt();

const MAX_ITERATIONS = 20;
const MAX_PARSE_RETRIES = 2;

const WRITE_TOOLS = new Set(["write_file"]);
const DELETE_TOOLS = new Set(["delete_file"]);
const TEST_TOOLS = new Set(["run_tests"]);
const VALIDATION_TOOLS = new Set(["run_lint", "run_typecheck", "run_build"]);
const ALL_ACTION_TOOLS = new Set([...WRITE_TOOLS, ...DELETE_TOOLS, ...TEST_TOOLS, ...VALIDATION_TOOLS]);

function detectRequestedActions(userMessage) {
  const lower = userMessage.toLowerCase();

  const needsWrite =
    /\b(?:create|write|implement|add|modify|update|fix|change|replace)\b/.test(lower) &&
    /\b(?:file|function|module|component|class|method|routine|code|script)\b/.test(lower);

  const needsTest =
    /\b(?:test|tests|testing|run tests|verify|validate)\b/.test(lower);

  const needsLint = /\b(?:lint)\b/.test(lower);
  const needsTypecheck = /\b(?:typecheck|type check|type-check)\b/.test(lower);
  const needsBuild = /\b(?:build)\b/.test(lower);
  const needsDelete = /\b(?:delete|remove|unlink)\b/.test(lower);

  return {
    write: needsWrite,
    delete: needsDelete,
    test: needsTest,
    lint: needsLint,
    typecheck: needsTypecheck,
    build: needsBuild,
  };
}

function createTaskState(userMessage) {
  const requested = detectRequestedActions(userMessage);
  return {
    requested,
    writeSucceeded: false,
    deleteSucceeded: false,
    testSucceeded: false,
    lintSucceeded: false,
    typecheckSucceeded: false,
    buildSucceeded: false,
  };
}

function updateTaskState(taskState, toolName, result, error) {
  if (WRITE_TOOLS.has(toolName)) {
    if (!error && result && !result.error && result.approved !== false) {
      taskState.writeSucceeded = true;
    }
  } else if (DELETE_TOOLS.has(toolName)) {
    if (!error && result && !result.error && result.approved !== false) {
      taskState.deleteSucceeded = true;
    }
  } else if (TEST_TOOLS.has(toolName)) {
    if (!error && result && result.exitCode === 0) {
      taskState.testSucceeded = true;
    }
  } else if (VALIDATION_TOOLS.has(toolName)) {
    if (!error && result && result.exitCode === 0) {
      if (toolName === "run_lint") taskState.lintSucceeded = true;
      if (toolName === "run_typecheck") taskState.typecheckSucceeded = true;
      if (toolName === "run_build") taskState.buildSucceeded = true;
    }
  }
}

function getIncompleteActions(taskState) {
  const incomplete = [];
  if (taskState.requested.write && !taskState.writeSucceeded) {
    incomplete.push("file write");
  }
  if (taskState.requested.delete && !taskState.deleteSucceeded) {
    incomplete.push("file delete");
  }
  if (taskState.requested.test && !taskState.testSucceeded) {
    incomplete.push("tests");
  }
  if (taskState.requested.lint && !taskState.lintSucceeded) {
    incomplete.push("lint");
  }
  if (taskState.requested.typecheck && !taskState.typecheckSucceeded) {
    incomplete.push("typecheck");
  }
  if (taskState.requested.build && !taskState.buildSucceeded) {
    incomplete.push("build");
  }
  return incomplete;
}

function buildCorrectiveMessage(incompleteActions, taskState) {
  const list = incompleteActions.join(", ");
  let hint = "";

  if (incompleteActions.includes("tests")) {
    if (!taskState.testSucceeded) {
      hint = " You have NOT run the tests yet. You must call the run_tests tool to actually execute the tests. Do NOT claim tests pass without calling run_tests first.";
    } else {
      hint = " The tests were run but failed. Inspect the failures and fix them.";
    }
  } else if (incompleteActions.includes("file write")) {
    hint = " Use write_file to create or update the required files.";
  }

  return `The task is not complete. The following required actions have not succeeded: ${list}.${hint} You must complete these actions before returning a final response. Continue working.`;
}

function inferStepCompletion(plan, toolName, result, error) {
  if (!plan || !plan.steps) return;
  if (error || !result || result.approved === false) return;

  const toolStepKeywords = {
    read_file: ["inspect", "read", "check", "examine", "review", "look", "see", "find"],
    list_files: ["inspect", "read", "check", "examine", "review", "list", "directory", "structure"],
    search_files: ["inspect", "read", "check", "examine", "search", "find", "locate"],
    write_file: ["create", "write", "implement", "add", "update", "modify", "fix", "change", "replace"],
    delete_file: ["delete", "remove", "unlink"],
    run_tests: ["test", "tests", "testing", "verify", "validate", "run"],
    run_lint: ["lint"],
    run_typecheck: ["typecheck", "type check", "type-check"],
    run_build: ["build", "compile"],
  };

  const keywords = toolStepKeywords[toolName] || [];
  if (keywords.length === 0) return;

  for (const step of plan.steps) {
    if (step.status === "completed") continue;
    const desc = step.description.toLowerCase();
    if (keywords.some((kw) => desc.includes(kw))) {
      step.status = "completed";
      return;
    }
  }
}

function formatPlanStatus(plan) {
  if (!plan || !plan.steps || plan.steps.length === 0) return "";
  return plan.steps
    .map((s) => `  ${s.status === "completed" ? "[x]" : "[ ]"} Step ${s.id}: ${s.description}`)
    .join("\n");
}

function getPendingPlanSteps(plan) {
  if (!plan || !plan.steps) return [];
  return plan.steps.filter((s) => s.status !== "completed");
}

export async function runAgent(
  userMessage,
  { approvalCallback, chatFn, executeToolCallFn, createPlanFn } = {}
) {
  const chatImpl = chatFn || defaultChat;
  const executeToolCallImpl = executeToolCallFn || defaultExecuteToolCall;
  const createPlanImpl = createPlanFn || defaultCreatePlan;

  let plan = null;
  try {
    plan = await createPlanImpl(userMessage, { chatFn: chatImpl });
  } catch {
    plan = null;
  }

  const planMessage = plan
    ? `\n\nYou have a task plan. Follow these steps in order:\n${formatPlanStatus(plan)}\n\nWhen you complete a step, mark it done by calling the appropriate tool.`
    : "";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + planMessage },
    { role: "user", content: userMessage },
  ];

  const taskState = createTaskState(userMessage);
  let correctiveMessagesSent = 0;
  const writtenFiles = new Map();
  const readAfterWrite = new Set();
  const listedTestFiles = new Set();
  const readFromDisk = new Set();
  let hasListedTestDir = false;
  let blockedRetries = 0;
  const MAX_BLOCKED_RETRIES = 3;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await chatImpl(messages);

    messages.push({ role: "assistant", content: response.content });

    let parsed;
    let parseRetries = 0;

    while (parseRetries < MAX_PARSE_RETRIES) {
      try {
        parsed = parseModelOutput(response.content);
        break;
      } catch (err) {
        parseRetries++;
        if (parseRetries >= MAX_PARSE_RETRIES) {
          return {
            success: false,
            error: `Failed to parse model output after ${MAX_PARSE_RETRIES} attempts: ${err.message}`,
            messages,
          };
        }

        messages.push({
          role: "user",
          content: `Parse error: ${err.message}. Please respond with valid JSON: {"type": "tool_call", "tool": "...", "args": {...}} or {"type": "final", "content": "..."}`,
        });

        const retryResponse = await chatImpl(messages);
        messages.push({ role: "assistant", content: retryResponse.content });
        response.content = retryResponse.content;
      }
    }

    if (parsed.kind === "final") {
      const incomplete = getIncompleteActions(taskState);
      if (incomplete.length > 0) {
        if (correctiveMessagesSent < 3) {
          correctiveMessagesSent++;
          messages.push({
            role: "user",
            content: buildCorrectiveMessage(incomplete, taskState),
          });
          continue;
        }
        return {
          success: false,
          error: `Task incomplete: required actions not finished (${incomplete.join(", ")})`,
          messages,
        };
      }

      return {
        success: true,
        content: parsed.content,
        messages,
      };
    }

    if (parsed.kind === "tool_call") {
      if (parsed.tool === "read_file" && parsed.args && parsed.args.path) {
        const readPath = parsed.args.path;
        readFromDisk.add(readPath);
        if (writtenFiles.has(readPath)) {
          readAfterWrite.add(readPath);
        }
      }

      if (parsed.tool === "write_file" && parsed.args && parsed.args.path) {
        const path = parsed.args.path;
        const previousContent = writtenFiles.get(path);

        if (previousContent !== undefined) {
          if (!readAfterWrite.has(path)) {
            blockedRetries++;
            if (blockedRetries >= MAX_BLOCKED_RETRIES) {
              messages.push({
                role: "user",
                content: `You have been blocked ${MAX_BLOCKED_RETRIES} times from rewriting "${path}" without reading it first. You MUST read_file "${path}" before writing it again. This is your last warning.`,
              });
            } else {
              messages.push({
                role: "user",
                content: `Skipped: file "${path}" was already written in this session. You must read_file "${path}" first to see its current content before writing it again. Do not rewrite a file without reading it.`,
              });
            }
            continue;
          }

          readAfterWrite.delete(path);
        }

        const isTestFile = path.includes("test") && path.endsWith(".js");
        const isNewFile = !readFromDisk.has(path) && !listedTestFiles.has(path) && !writtenFiles.has(path);

        if (isTestFile && isNewFile && !hasListedTestDir) {
          blockedRetries++;
          messages.push({
            role: "user",
            content: `Skipped: cannot write to test file "${path}" without first listing the test directory. You MUST call list_files on the test directory first to discover existing test files and their naming conventions. Do not create or write test files without inspecting the test directory first.`,
          });
          continue;
        }

        if (isTestFile && isNewFile && listedTestFiles.size > 0) {
          blockedRetries++;
          const existingTests = [...listedTestFiles].join(", ");
          if (blockedRetries >= MAX_BLOCKED_RETRIES) {
            messages.push({
              role: "user",
              content: `STOP creating new test files. The existing test files are: ${existingTests}. You already have a test file for this module. Your ONLY option is to read one of those files and update it. If you have already updated the test file, then run the tests now using run_tests. Do NOT write any more test files.`,
            });
          } else {
            messages.push({
              role: "user",
              content: `Skipped: cannot create new test file "${path}". Test files already exist: ${existingTests}. Read the existing test file and update it with your new tests, then run the tests.`,
            });
          }
          continue;
        }
      }

      let result;
      let error = null;
      let approved = true;
      let timedOut = false;
      let truncated = false;

      try {
        result = await executeToolCallImpl(
          { tool: parsed.tool, args: parsed.args },
          approvalCallback
        );
        if (result.approved === false) {
          approved = false;
        }
        if (result.timedOut) {
          timedOut = true;
        }
        if (result.truncated) {
          truncated = true;
        }
        if (result.error) {
          error = result.error;
        }
      } catch (err) {
        result = { error: err.message };
        error = err.message;
      }

      if (parsed.tool === "write_file" && parsed.args && !error && approved !== false) {
        writtenFiles.set(parsed.args.path, parsed.args.content);
        blockedRetries = 0;
      }

      if (parsed.tool === "list_files" && !error && result && Array.isArray(result)) {
        const dir = parsed.args.path || ".";
        const isTestDir = dir === "test" || dir === "tests" || dir.endsWith("/test") || dir.endsWith("/tests");
        if (isTestDir) {
          hasListedTestDir = true;
        }
        for (const item of result) {
          if (item.type === "file" && item.name && item.name.includes("test") && item.name.endsWith(".js")) {
            const fullPath = dir === "." ? item.name : `${dir}/${item.name}`;
            listedTestFiles.add(fullPath);
          }
        }
      }

      updateTaskState(taskState, parsed.tool, result, error);
      inferStepCompletion(plan, parsed.tool, result, error);

      const toolMessage = formatToolResult(parsed.tool, result, {
        error,
        approved,
        timedOut,
        truncated,
      });

      const pendingSteps = getPendingPlanSteps(plan);
      const stepHint =
        pendingSteps.length > 0
          ? `\nPlan progress: ${plan.steps.filter((s) => s.status === "completed").length}/${plan.steps.length} steps done. Next: ${pendingSteps[0].description}`
          : "";

      messages.push({ role: "user", content: toolMessage + stepHint });
    }
  }

  return {
    success: false,
    error: `Exceeded max iterations (${MAX_ITERATIONS})`,
    messages,
  };
}
