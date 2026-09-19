// Defines tool schemas (name, description, parameters with types and bounds). 
// Validates args, dispatches to tool functions, handles approval for dangerous operations.

import { readFile, writeFile, deleteFile, listFiles, searchFiles } from "../tools/filesystem.js";
import { runTests, runLint, runTypecheck, runBuild } from "../tools/shell.js";

const TOOL_SCHEMAS = {
  read_file: {
    description: "Read the contents of a file",
    params: {
      path: { type: "string", required: true, description: "File path relative to workspace", maxLength: 1000 },
    },
  },
  write_file: {
    description: "Create or replace a file with new content",
    params: {
      path: { type: "string", required: true, description: "File path relative to workspace", maxLength: 1000 },
      content: { type: "string", required: true, description: "File content to write", maxLength: 1000000 },
    },
  },
  delete_file: {
    description: "Delete a file",
    params: {
      path: { type: "string", required: true, description: "File path relative to workspace", maxLength: 1000 },
    },
  },
  list_files: {
    description: "List files and directories in a path",
    params: {
      path: { type: "string", required: false, description: "Directory path (default: workspace root)", maxLength: 1000 },
    },
  },
  search_files: {
    description: "Search for files by name pattern (regex). Does NOT search file contents.",
    params: {
      pattern: { type: "string", required: true, description: "Regex pattern to match filenames", maxLength: 500 },
      path: { type: "string", required: false, description: "Directory to search in (default: workspace root)", maxLength: 1000 },
      maxDepth: { type: "number", required: false, description: "Max recursion depth (default: 10)", min: 1, max: 50 },
      maxMatches: { type: "number", required: false, description: "Max results to return (default: 100)", min: 1, max: 1000 },
    },
  },
  run_tests: {
    description: "Run the project's test suite",
    params: {
      cwd: { type: "string", required: false, description: "Working directory relative to workspace" },
      timeout: { type: "number", required: false, description: "Timeout in ms (default: 30000)", min: 1000, max: 120000 },
    },
  },
  run_lint: {
    description: "Run the linter",
    params: {
      cwd: { type: "string", required: false, description: "Working directory relative to workspace" },
      timeout: { type: "number", required: false, description: "Timeout in ms (default: 30000)", min: 1000, max: 120000 },
    },
  },
  run_typecheck: {
    description: "Run type checking",
    params: {
      cwd: { type: "string", required: false, description: "Working directory relative to workspace" },
      timeout: { type: "number", required: false, description: "Timeout in ms (default: 30000)", min: 1000, max: 120000 },
    },
  },
  run_build: {
    description: "Build the project",
    params: {
      cwd: { type: "string", required: false, description: "Working directory relative to workspace" },
      timeout: { type: "number", required: false, description: "Timeout in ms (default: 30000)", min: 1000, max: 120000 },
    },
  },
};

const TOOL_FUNCTIONS = {
  read_file: readFile,
  write_file: writeFile,
  delete_file: deleteFile,
  list_files: listFiles,
  search_files: searchFiles,
  run_tests: runTests,
  run_lint: runLint,
  run_typecheck: runTypecheck,
  run_build: runBuild,
};

const TOOLS_REQUIRING_APPROVAL = new Set(["write_file", "delete_file"]);

export function getToolSchemas() {
  return TOOL_SCHEMAS;
}

export function getToolSchema(toolName) {
  return TOOL_SCHEMAS[toolName] || null;
}

function validateArgs(toolName, args) {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    throw new Error(`Unknown tool: "${toolName}"`);
  }

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("args must be a plain object");
  }

  for (const [param, config] of Object.entries(schema.params)) {
    if (config.required && !(param in args)) {
      throw new Error(`Missing required parameter: "${param}"`);
    }

    if (param in args) {
      const value = args[param];

      if (config.type === "string" && typeof value !== "string") {
        throw new Error(`Parameter "${param}" must be a string, got ${typeof value}`);
      }
      if (config.type === "number" && typeof value !== "number") {
        throw new Error(`Parameter "${param}" must be a number, got ${typeof value}`);
      }
      if (config.type === "array" && !Array.isArray(value)) {
        throw new Error(`Parameter "${param}" must be an array, got ${typeof value}`);
      }

      if (config.type === "string" && config.maxLength && value.length > config.maxLength) {
        throw new Error(`Parameter "${param}" exceeds max length of ${config.maxLength}`);
      }

      if (config.type === "number") {
        if (config.min !== undefined && value < config.min) {
          throw new Error(`Parameter "${param}" must be at least ${config.min}`);
        }
        if (config.max !== undefined && value > config.max) {
          throw new Error(`Parameter "${param}" must be at most ${config.max}`);
        }
      }
    }
  }

  const knownParams = new Set(Object.keys(schema.params));
  for (const key of Object.keys(args)) {
    if (!knownParams.has(key)) {
      throw new Error(`Unknown parameter: "${key}"`);
    }
  }

  return true;
}

export async function executeToolCall(toolCall, approvalCallback) {
  const { tool, args = {} } = toolCall;

  if (!tool || typeof tool !== "string") {
    throw new Error("tool_call must include a 'tool' string");
  }

  const fn = TOOL_FUNCTIONS[tool];
  if (!fn) {
    throw new Error(
      `Unknown tool: "${tool}". Available: ${Object.keys(TOOL_FUNCTIONS).join(", ")}`
    );
  }

  validateArgs(tool, args);

  if (TOOLS_REQUIRING_APPROVAL.has(tool)) {
    if (!approvalCallback) {
      return {
        error: "Operation rejected: approval required but no approval callback available",
        approved: false,
      };
    }
    const approved = await approvalCallback({
      tool,
      args,
    });
    if (!approved) {
      return {
        error: "Operation rejected by user",
        approved: false,
      };
    }
  }

  return fn(args);
}

export function parseModelOutput(raw) {
  if (typeof raw !== "string") {
    throw new Error("Model output must be a string");
  }

  const trimmed = raw.trim();

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      'No JSON object found. Expected {"type": "tool_call", ...} or {"type": "final", ...}'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Invalid JSON. Expected {"type": "tool_call", ...} or {"type": "final", ...}`
    );
  }

  if (!parsed.type || typeof parsed.type !== "string") {
    throw new Error('Output must include a "type" field');
  }

  // Support models that use the tool name as the type.
  // Accept either nested args or flat tool parameters.
  if (TOOL_SCHEMAS[parsed.type]) {
    const args =
      parsed.args && typeof parsed.args === "object"
        ? parsed.args
        : Object.fromEntries(
            Object.entries(parsed).filter(
              ([key]) => key !== "type"
            )
          );

    return {
      kind: "tool_call",
      tool: parsed.type,
      args,
    };
  }

  if (parsed.type === "tool_call") {
    if (!parsed.tool || typeof parsed.tool !== "string") {
      throw new Error('tool_call must include a "tool" field');
    }
    if (parsed.args !== undefined && (typeof parsed.args !== "object" || parsed.args === null)) {
      throw new Error('tool_call "args" must be an object');
    }
    return { kind: "tool_call", tool: parsed.tool, args: parsed.args || {} };
  }

  if (parsed.type === "final") {
    return { kind: "final", content: parsed.content || "" };
  }

  throw new Error(
    `Unknown output type: "${parsed.type}". Use "tool_call" or "final".`
  );
}

export function formatToolResult(toolName, result, { error, approved, timedOut, truncated } = {}) {
  const status = error ? "error" : approved === false ? "rejected" : timedOut ? "timeout" : truncated ? "truncated" : "success";

  return JSON.stringify({
    type: "tool_result",
    tool: toolName,
    status,
    result,
  });
}
