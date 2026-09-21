// Task planning module. Asks the LLM to break a complex request into smaller steps.
// Returns a structured plan that the agent uses as a guide during execution.

import { chat as defaultChat } from "./llm.js";

const PLAN_PROMPT = `You are a task planner for a coding assistant.

Given the user's request below, break it into a numbered list of concrete, actionable steps.

Rules:
- Include an "inspect" step if the task might require reading existing code or config first.
- Include a "create/update" step for any file modifications.
- Include a "test" step if the task involves writing or changing code.
- Include a "verify" or "fix" step if tests or validation are needed.
- Keep steps small and specific. Each step should be one clear action.
- Do NOT include more than 8 steps.
- Do NOT mark any step as complete. All steps start as "pending".

Respond with ONLY valid JSON in this exact format:
{
  "type": "plan",
  "steps": [
    {"id": 1, "description": "...", "status": "pending"}
  ]
}

User request:
`;

export async function createPlan(userMessage, { chatFn } = {}) {
  const chatImpl = chatFn || defaultChat;

  const response = await chatImpl([
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: userMessage },
  ]);

  let parsed;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    throw new Error("Failed to parse plan from LLM response");
  }

  if (parsed.type !== "plan" || !Array.isArray(parsed.steps)) {
    throw new Error("LLM response is not a valid plan (expected type \"plan\" and steps array)");
  }

  for (const step of parsed.steps) {
    if (typeof step.id !== "number" || typeof step.description !== "string") {
      throw new Error("Invalid step format: each step must have id (number) and description (string)");
    }
    step.status = "pending";
  }

  return parsed;
}
