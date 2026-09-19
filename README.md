# MiniCode

A lightweight coding agent harness that lets a local LLM read, write, delete, search files, and run tests inside a sandboxed workspace.

## Overview

MiniCode acts as a bridge between a local LLM and your filesystem. The model cannot directly access files on your computer — instead, it requests actions via a JSON protocol, and the harness validates and executes them safely.

## Architecture

```
User → MiniCode → LLM (Ollama) → Tool Calls → Filesystem/Shell
         ↑________________________________↓
                   (results fed back)
```

The agent loop:
1. User sends a message
2. Harness sends message + tool schemas to LLM
3. LLM responds with JSON: either a `tool_call` or `final` answer
4. Harness validates, approves (if needed), and executes the tool
5. Result is fed back to the LLM
6. Repeat until the LLM returns a `final` response

The orchestrator tracks task state (requested vs. completed actions) and rejects premature `final` responses when required actions are still unfinished.

## LLM

Uses [Ollama](https://ollama.com/) running locally with the **qwen2.5-coder:7b** model.

```bash
# Install and start Ollama
ollama serve

# Pull the model
ollama pull qwen2.5-coder:7b
```

## Project Structure

```
minicode/
├── src/
│   ├── index.js        # CLI entry point
│   ├── agent.js        # Agent loop (message → LLM → tool → repeat)
│   ├── llm.js          # Ollama API client
│   ├── tools.js        # Tool schema definitions, validation, dispatch
│   └── context.js      # System prompt builder
├── tools/
│   ├── filesystem.js   # File operations (read, write, delete, list, search)
│   └── shell.js        # Preconfigured command execution
├── test/
│   └── agent.test.js   # Agent loop regression tests
├── workspace/          # Default sandbox directory
├── prompts/            # (reserved for prompt templates)
├── logs/               # (reserved for session logs)
├── package.json
└── README.md
```

## Files

### `src/index.js`
CLI entry point. Takes a user message as an argument, runs the agent, prints the result.

### `src/agent.js`
Core agent loop. Manages conversation history, parses model output, executes tools, feeds results back. Max 20 iterations with retry on parse failure.

Includes task state tracking: detects the user's intent (write, delete, test, lint, typecheck, build), tracks whether each required action has succeeded, and prevents the model from returning a `final` response before all requested actions are complete. After a premature `final`, the orchestrator sends a corrective message and continues the loop.

Supports dependency injection of `chatFn` and `executeToolCallFn` for testing.

### `src/llm.js`
Thin wrapper around the Ollama chat API. Sends messages with `format: "json"` for structured output.

### `src/tools.js`
Defines tool schemas (name, description, parameters with types and bounds). Validates args, dispatches to tool functions, handles approval for dangerous operations. Approval-fail-closed: tools requiring approval are rejected if no approval callback is available.

### `src/context.js`
Builds the system prompt with tool schemas injected. Instructs the model on the JSON protocol and execution rules.

### `tools/filesystem.js`
- `readFile` — Read file contents
- `writeFile` — Create/replace files (requires approval)
- `deleteFile` — Delete a file (requires approval)
- `listFiles` — List directory entries
- `searchFiles` — Regex search over filenames with depth/match limits, ignores `node_modules`, `.git`, etc.

### `tools/shell.js`
Preconfigured commands only (no arbitrary shell execution):
- `run_tests` → `npm test`
- `run_lint` → `npm run lint`
- `run_typecheck` → `npm run typecheck`
- `run_build` → `npm run build`

Features: workspace sandboxing, streaming output truncation, timeout, approval callback.

## Testing

```bash
npm test
```

Runs all tests in `test/` using Node's built-in test runner. Tests mock the LLM and tool execution to verify agent loop behavior: multi-step execution, premature final prevention, write-then-test workflow, tool result verification, approval fail-closed, and parse error recovery.

## Usage

```bash
# Set workspace and run
AGENT_WORKSPACE=./workspace node src/index.js "list all files"

# Create a file (prompts for approval)
AGENT_WORKSPACE=./workspace node src/index.js "create a hello.js with a function that returns hello world"

# Delete a file (prompts for approval)
AGENT_WORKSPACE=./workspace node src/index.js "delete the file src/demo.js"

# Run tests
AGENT_WORKSPACE=./workspace node src/index.js "run the tests"
```

## Tool Protocol

The model must return one of:

```json
{"type": "tool_call", "tool": "read_file", "args": {"path": "src/index.js"}}
```

```json
{"type": "final", "content": "Done. Created hello.js with the requested function."}
```

## Security

- **Sandboxed workspace** — All file operations are restricted to the workspace directory
- **No arbitrary shell** — Only preconfigured commands (npm test, lint, etc.)
- **Approval required** — File writes and deletes require user confirmation
- **Approval fail-closed** — Destructive tools are rejected if no approval callback is available
- **Path validation** — Prevents directory traversal attacks
- **Output limits** — Streaming truncation prevents memory exhaustion
- **Type validation** — All tool args are type-checked with bounds

## License

ISC
