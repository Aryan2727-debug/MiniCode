import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPlan } from "../src/planner.js";

function mockChat(responseContent) {
  return async () => ({ role: "assistant", content: responseContent });
}

function makePlan(steps) {
  return JSON.stringify({ type: "plan", steps });
}

describe("createPlan", function () {
  it("returns a valid plan from LLM response", async function () {
    const planJson = makePlan([
      { id: 1, description: "Inspect package.json", status: "pending" },
      { id: 2, description: "Implement capitalize function", status: "pending" },
      { id: 3, description: "Write unit tests", status: "pending" },
      { id: 4, description: "Run tests and fix failures", status: "pending" },
    ]);

    const plan = await createPlan("add a capitalize function and test it", {
      chatFn: mockChat(planJson),
    });

    assert.equal(plan.type, "plan");
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.steps[0].description, "Inspect package.json");
    assert.equal(plan.steps[0].status, "pending");
    assert.equal(plan.steps[3].description, "Run tests and fix failures");
    assert.equal(plan.steps[3].status, "pending");
  });

  it("forces all steps to pending status regardless of LLM output", async function () {
    const planJson = makePlan([
      { id: 1, description: "Step one", status: "completed" },
      { id: 2, description: "Step two", status: "completed" },
    ]);

    const plan = await createPlan("do something", {
      chatFn: mockChat(planJson),
    });

    assert.equal(plan.steps[0].status, "pending");
    assert.equal(plan.steps[1].status, "pending");
  });

  it("throws on invalid JSON", async function () {
    await assert.rejects(
      () => createPlan("task", { chatFn: mockChat("not json") }),
      /Failed to parse plan/
    );
  });

  it("throws when response is not a plan type", async function () {
    const notPlan = JSON.stringify({ type: "final", content: "done" });

    await assert.rejects(
      () => createPlan("task", { chatFn: mockChat(notPlan) }),
      /not a valid plan/
    );
  });

  it("throws when steps is missing", async function () {
    const badPlan = JSON.stringify({ type: "plan" });

    await assert.rejects(
      () => createPlan("task", { chatFn: mockChat(badPlan) }),
      /not a valid plan/
    );
  });

  it("throws when step has invalid format", async function () {
    const badPlan = makePlan([{ id: "not-a-number", description: "Step" }]);

    await assert.rejects(
      () => createPlan("task", { chatFn: mockChat(badPlan) }),
      /Invalid step format/
    );
  });

  it("throws when step is missing description", async function () {
    const badPlan = makePlan([{ id: 1 }]);

    await assert.rejects(
      () => createPlan("task", { chatFn: mockChat(badPlan) }),
      /Invalid step format/
    );
  });

  it("returns plan with multiple steps", async function () {
    const planJson = makePlan([
      { id: 1, description: "First step" },
      { id: 2, description: "Second step" },
      { id: 3, description: "Third step" },
    ]);

    const plan = await createPlan("complex task", {
      chatFn: mockChat(planJson),
    });

    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].id, 1);
    assert.equal(plan.steps[1].id, 2);
    assert.equal(plan.steps[2].id, 3);
  });
});
