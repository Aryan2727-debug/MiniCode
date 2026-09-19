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

function buildCorrectiveMessage(incompleteActions) {
  const list = incompleteActions.join(", ");
  return `The task is not complete. The following required actions have not succeeded: ${list}. You must complete these actions before returning a final response. Continue working.`;
}

export async function runAgent(
  userMessage,
  { approvalCallback, chatFn, executeToolCallFn } = {}
) {
  const chatImpl = chatFn || defaultChat;
  const executeToolCallImpl = executeToolCallFn || defaultExecuteToolCall;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  const taskState = createTaskState(userMessage);
  let correctiveMessagesSent = 0;

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
            content: buildCorrectiveMessage(incomplete),
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

      updateTaskState(taskState, parsed.tool, result, error);

      const toolMessage = formatToolResult(parsed.tool, result, {
        error,
        approved,
        timedOut,
        truncated,
      });
      messages.push({ role: "user", content: toolMessage });
    }
  }

  return {
    success: false,
    error: `Exceeded max iterations (${MAX_ITERATIONS})`,
    messages,
  };
}
