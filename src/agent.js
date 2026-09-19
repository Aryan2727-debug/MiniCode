import { chat } from "./llm.js";
import { buildSystemPrompt } from "./context.js";
import {
  executeToolCall,
  parseModelOutput,
  formatToolResult,
} from "./tools.js";

const SYSTEM_PROMPT = buildSystemPrompt();

const MAX_ITERATIONS = 20;
const MAX_PARSE_RETRIES = 2;

export async function runAgent(userMessage, { approvalCallback } = {}) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await chat(messages);
    console.log("RAW MODEL CONTENT:", response.content);

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

        const retryResponse = await chat(messages);
        messages.push({ role: "assistant", content: retryResponse.content });
        response.content = retryResponse.content;
      }
    }

    if (parsed.kind === "final") {
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
        result = await executeToolCall(
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

      console.log("TOOL:", parsed.tool);
      console.log("TOOL ARGS:", JSON.stringify(parsed.args, null, 2));
      console.log("TOOL RESULT:", JSON.stringify(result, null, 2));
      console.log("TOOL ERROR:", error);
      console.log("APPROVED:", approved);

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
