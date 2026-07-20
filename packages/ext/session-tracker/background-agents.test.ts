import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createNeedsInputLifecycle } from "./index.js";

test("stays working until all background agents finish", async () => {
  const states: string[] = [];
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    async () => true,
    () => {},
  );

  await lifecycle.agentStart();
  await lifecycle.backgroundAgentStarted("a");
  await lifecycle.backgroundAgentStarted("b");
  lifecycle.agentEnd({
    messages: [{ role: "assistant", content: [{ type: "text", text: "Need a choice" }] }],
  } as AgentEndEvent);
  await lifecycle.agentSettled({} as ExtensionContext);
  await lifecycle.backgroundAgentFinished("a");
  await lifecycle.backgroundAgentFinished("b");

  expect(states).toEqual(["working", "working", "working", "working", "needs-input"]);
});
