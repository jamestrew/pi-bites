import { describe, expect, test } from "vitest";

import {
  assistantMessage,
  createRuntimeHarness,
  queuedCustomMessage,
} from "./test/support/runtime-harness.js";

describe("vendored goal lifecycle", () => {
  test("continues in-session and reconstructs the persisted goal after reload", async () => {
    const harness = createRuntimeHarness();

    await harness.runCommand("ship issue 185");
    const created = harness.snapshot().goal;
    expect(created).toMatchObject({ objective: "ship issue 185", status: "active" });

    const initialTurn = harness.sentMessages[0];
    expect(initialTurn).toBeDefined();
    if (!initialTurn || typeof initialTurn.message.content !== "string") {
      throw new Error("Expected a text goal continuation.");
    }
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: initialTurn.message.content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedCustomMessage(initialTurn),
    });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 10, output: 2 }),
      toolResults: [],
    });

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "continuation",
      goalId: created?.goalId,
    });

    await harness.reloadSession("reload");
    expect(harness.snapshot().goal).toMatchObject({
      goalId: created?.goalId,
      objective: "ship issue 185",
      status: "active",
    });

    const result = (await harness.runTool("get_goal", {})) as {
      details: { goal: { goalId: string; objective: string } };
    };
    expect(result.details.goal).toMatchObject({
      goalId: created?.goalId,
      objective: "ship issue 185",
    });

    await harness.runTool("update_goal", { status: "complete" });
    const next = (await harness.runTool("create_goal", { objective: "next goal" })) as {
      details: { goal: { objective: string; status: string } };
    };
    expect(next.details.goal).toMatchObject({ objective: "next goal", status: "active" });
  });
});
