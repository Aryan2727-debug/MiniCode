import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(
  process.env.AGENT_WORKSPACE || "./workspace"
);

const PRECONFIGURED_COMMANDS = {
  run_tests: {
    description: "Run the project's test suite",
    command: "npm",
    args: ["test"],
  },
  run_lint: {
    description: "Run the linter",
    command: "npm",
    args: ["run", "lint"],
  },
  run_typecheck: {
    description: "Run type checking",
    command: "npm",
    args: ["run", "typecheck"],
  },
  run_build: {
    description: "Build the project",
    command: "npm",
    args: ["run", "build"],
  },
};

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT_SIZE = 50000;

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function appendLimited(current, chunk, maxLen) {
  if (current.length >= maxLen) {
    return current;
  }
  const remaining = maxLen - current.length;
  return current + chunk.toString().slice(0, remaining);
}

function truncateOutput(output, maxLen) {
  if (output.length <= maxLen) return output;
  return (
    output.slice(0, maxLen) +
    `\n... [truncated, ${output.length - maxLen} bytes omitted]`
  );
}

export async function runTests({
  target = "all",
  cwd = ".",
  timeout = DEFAULT_TIMEOUT,
  approvalCallback,
} = {}) {
  return runPreconfigured("run_tests", { cwd, timeout, approvalCallback });
}

export async function runLint({
  cwd = ".",
  timeout = DEFAULT_TIMEOUT,
  approvalCallback,
} = {}) {
  return runPreconfigured("run_lint", { cwd, timeout, approvalCallback });
}

export async function runTypecheck({
  cwd = ".",
  timeout = DEFAULT_TIMEOUT,
  approvalCallback,
} = {}) {
  return runPreconfigured("run_typecheck", { cwd, timeout, approvalCallback });
}

export async function runBuild({
  cwd = ".",
  timeout = DEFAULT_TIMEOUT,
  approvalCallback,
} = {}) {
  return runPreconfigured("run_build", { cwd, timeout, approvalCallback });
}

async function runPreconfigured(
  commandName,
  { cwd = ".", timeout = DEFAULT_TIMEOUT, approvalCallback } = {}
) {
  const config = PRECONFIGURED_COMMANDS[commandName];
  if (!config) {
    throw new Error(`Unknown preconfigured command: "${commandName}"`);
  }

  const resolvedCwd = path.resolve(ROOT, cwd);
  if (!isWithinRoot(ROOT, resolvedCwd)) {
    throw new Error("cwd must be within the workspace");
  }

  if (approvalCallback) {
    const approved = await approvalCallback({
      command: commandName,
      description: config.description,
      executable: config.command,
      args: config.args,
      cwd: resolvedCwd,
    });
    if (!approved) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "Command rejected by user",
        approved: false,
        timedOut: false,
        truncated: false,
        command: commandName,
      };
    }
  }

  return executeProcess(config.command, config.args, resolvedCwd, timeout, commandName);
}

function executeProcess(executable, args, cwd, timeout, commandName) {
  return new Promise((resolve) => {
    const proc = spawn(executable, args, {
      cwd,
      timeout,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let killed = false;

    proc.stdout.on("data", (data) => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout = appendLimited(stdout, data, MAX_OUTPUT_SIZE);
      } else {
        truncated = true;
      }
    });

    proc.stderr.on("data", (data) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr = appendLimited(stderr, data, MAX_OUTPUT_SIZE);
      } else {
        truncated = true;
      }
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? -1 : exitCode,
        stdout: truncateOutput(stdout, MAX_OUTPUT_SIZE),
        stderr: killed
          ? `Process timed out after ${timeout}ms`
          : truncateOutput(stderr, MAX_OUTPUT_SIZE),
        timedOut: killed,
        truncated,
        approved: true,
        command: commandName,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: err.message,
        approved: true,
        timedOut: false,
        truncated: false,
        command: commandName,
      });
    });
  });
}
