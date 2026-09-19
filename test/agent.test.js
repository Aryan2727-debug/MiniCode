import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.js";

function createMockChat(responses) {
  let callIndex = 0;
  return async (messages) => {
    if (callIndex >= responses.length) {
      throw new Error("Mock chat called " + (callIndex + 1) + " times, but only " + responses.length + " responses configured");
    }
    const content = responses[callIndex];
    callIndex++;
    return { role: "assistant", content };
  };
}

function createMockToolCall(toolImplementations) {
  const impls = toolImplementations || {};
  return async (toolCall, approvalCallback) => {
    const { tool, args } = toolCall;

    if (tool === "write_file") {
      if (approvalCallback) {
        const approved = await approvalCallback({ tool, args });
        if (!approved) {
          return { error: "Operation rejected by user", approved: false };
        }
      }
      if (impls.write_file) return impls.write_file(args);
      return "Updated " + args.path;
    }

    if (tool === "run_tests") {
      if (impls.run_tests) return impls.run_tests(args);
      return { exitCode: 0, stdout: "All tests passed", stderr: "" };
    }

    if (tool === "read_file") {
      if (impls.read_file) return impls.read_file(args);
      return "file content";
    }

    if (tool === "list_files") {
      if (impls.list_files) return impls.list_files(args);
      return [];
    }

    throw new Error("Unknown tool: " + tool);
  };
}

function finalMsg(content) {
  return JSON.stringify({ type: "final", content: content });
}

function toolCallMsg(tool, args) {
  return JSON.stringify({ type: "tool_call", tool: tool, args: args });
}

describe("runAgent", function () {
  describe("multi-step execution", function () {
    it("continues through tool calls until final response", async function () {
      const responses = [
        toolCallMsg("read_file", { path: "src/index.js" }),
        toolCallMsg("list_files", { path: "src" }),
        finalMsg("Here is the project structure."),
      ];

      const result = await runAgent("show me the project", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "Here is the project structure.");
    });

    it("handles tool call followed by another tool call then final", async function () {
      const responses = [
        toolCallMsg("read_file", { path: "package.json" }),
        toolCallMsg("read_file", { path: "src/agent.js" }),
        finalMsg("Reviewed the files."),
      ];

      const result = await runAgent("review the code", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "Reviewed the files.");
    });
  });

  describe("premature final responses", function () {
    it("rejects final when write was requested but not completed", async function () {
      const responses = [
        toolCallMsg("read_file", { path: "src/index.js" }),
        finalMsg("I have read the file."),
        finalMsg("Still just reading."),
        finalMsg("Done reading."),
        finalMsg("Final answer."),
      ];

      const result = await runAgent("create a function and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });

    it("rejects final when test was requested but not completed", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/utils.js", content: "export const x = 1;" }),
        finalMsg("File created."),
        finalMsg("All done."),
        finalMsg("Finished."),
        finalMsg("Really done."),
      ];

      const result = await runAgent("create a function and run the tests", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });

    it("accepts final when both write and test are completed", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/utils.js", content: "export const x = 1;" }),
        toolCallMsg("run_tests", {}),
        finalMsg("Done! Written and tested."),
      ];

      const result = await runAgent("create a function and run the tests", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "Done! Written and tested.");
    });
  });

  describe("write-then-test workflow", function () {
    it("requires tests after write when user requests both", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/new.js", content: "export default 42;" }),
        finalMsg("File created."),
        finalMsg("Really done."),
        finalMsg("OK."),
        finalMsg("Done."),
      ];

      const result = await runAgent("write a new module and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });

    it("accepts final after write and test both succeed", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/new.js", content: "export default 42;" }),
        toolCallMsg("run_tests", {}),
        finalMsg("All done."),
      ];

      const result = await runAgent("write a new module and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "All done.");
    });
  });

  describe("tool execution result verification", function () {
    it("does not mark write as succeeded when tool returns error", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/bad.js", content: "" }),
        finalMsg("File created."),
        finalMsg("Done."),
        finalMsg("OK."),
        finalMsg("Done."),
      ];

      const mockToolCall = createMockToolCall({
        write_file: function () { return { error: "Permission denied" }; },
      });

      const result = await runAgent("create a file and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: mockToolCall,
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });

    it("does not mark test as succeeded when tests fail", async function () {
      const responses = [
        toolCallMsg("run_tests", {}),
        finalMsg("Tests ran."),
        finalMsg("Done."),
        finalMsg("OK."),
        finalMsg("Done."),
      ];

      const mockToolCall = createMockToolCall({
        run_tests: function () { return { exitCode: 1, stdout: "", stderr: "1 test failed" }; },
      });

      const result = await runAgent("run the tests", {
        chatFn: createMockChat(responses),
        executeToolCallFn: mockToolCall,
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });

    it("marks write as succeeded on successful write", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/good.js", content: "export default 1;" }),
        finalMsg("Created."),
      ];

      const result = await runAgent("create a file", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
    });
  });

  describe("approval fail closed", function () {
    it("rejects write_file when no approval callback is provided", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/new.js", content: "x" }),
        finalMsg("Done."),
        finalMsg("OK."),
        finalMsg("Done."),
        finalMsg("Really done."),
      ];

      const result = await runAgent("create a file", {
        chatFn: createMockChat(responses),
        executeToolCallFn: async function (toolCall) {
          if (toolCall.tool === "write_file") {
            return { error: "Operation rejected: approval required but no approval callback available", approved: false };
          }
          return "ok";
        },
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
      const toolResults = result.messages.filter(function (m) {
        try {
          const parsed = JSON.parse(m.content);
          return parsed.type === "tool_result" && parsed.status === "error" && parsed.result.approved === false;
        } catch (_e) {
          return false;
        }
      });
      assert.ok(toolResults.length > 0, "Should have a rejected tool result");
    });
  });

  describe("parse error recovery", function () {
    it("recovers from parse errors by requesting valid JSON", async function () {
      const responses = [
        "I will help you with that.",
        toolCallMsg("read_file", { path: "src/index.js" }),
        finalMsg("Here it is."),
      ];

      const result = await runAgent("read the file", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "Here it is.");
    });
  });

  describe("iteration limit", function () {
    it("returns error when max iterations exceeded", async function () {
      const responses = [];
      for (let i = 0; i < 25; i++) {
        responses.push(toolCallMsg("read_file", { path: "src/index.js" }));
      }

      const result = await runAgent("do something", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Exceeded max iterations/);
    });
  });

  describe("corrective message flow", function () {
    it("sends corrective messages when model tries to finalize early", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/foo.js", content: "export const x = 1;" }),
        finalMsg("File created, all done."),
        finalMsg("Really done."),
        finalMsg("OK done."),
        finalMsg("Done."),
      ];

      const result = await runAgent("create a file and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, false);

      const correctiveMessages = result.messages.filter(function (m) {
        return m.role === "user" && typeof m.content === "string" && m.content.startsWith("The task is not complete");
      });
      assert.ok(correctiveMessages.length >= 1, "Should have sent at least one corrective message");
    });

    it("allows final after corrective messages when model completes work", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/bar.js", content: "export const y = 2;" }),
        finalMsg("File created."),
        toolCallMsg("run_tests", {}),
        finalMsg("All done now."),
      ];

      const result = await runAgent("write a file and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: createMockToolCall(),
      });

      assert.equal(result.success, true);
      assert.equal(result.content, "All done now.");
    });
  });

  describe("rejected tool calls", function () {
    it("does not mark action as succeeded when tool call is rejected", async function () {
      const responses = [
        toolCallMsg("write_file", { path: "src/baz.js", content: "x" }),
        finalMsg("Done."),
        finalMsg("Still done."),
        finalMsg("OK."),
        finalMsg("Done."),
      ];

      const mockToolCall = createMockToolCall({
        write_file: function () { return { error: "Operation rejected by user", approved: false }; },
      });

      const result = await runAgent("create a file and test it", {
        chatFn: createMockChat(responses),
        executeToolCallFn: mockToolCall,
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Task incomplete/);
    });
  });
});
