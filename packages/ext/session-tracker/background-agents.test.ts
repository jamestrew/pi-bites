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

test("reports working during compaction and restores the settled state", async () => {
  const states: string[] = [];
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    async () => true,
    () => {},
  );

  await lifecycle.agentStart();
  lifecycle.agentEnd({
    messages: [{ role: "assistant", content: [{ type: "text", text: "Need a choice" }] }],
  } as AgentEndEvent);
  await lifecycle.agentSettled({} as ExtensionContext);
  await lifecycle.compactionStarted();
  await lifecycle.compactionFinished();

  await lifecycle.agentStart();
  await lifecycle.compactionStarted();
  lifecycle.agentEnd({
    messages: [{ role: "assistant", content: [{ type: "text", text: "Need a choice" }] }],
  } as AgentEndEvent);
  await lifecycle.agentSettled({} as ExtensionContext);

  expect(states).toEqual([
    "working",
    "needs-input",
    "working",
    "needs-input",
    "working",
    "working",
    "needs-input",
  ]);
});

test("stays working until overlapping compactions finish", async () => {
  const states: string[] = [];
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    async () => false,
    () => {},
  );

  await lifecycle.compactionStarted();
  await lifecycle.compactionStarted();
  await lifecycle.compactionFinished();
  await lifecycle.compactionFinished();

  expect(states).toEqual(["working", "working", "working", "idle"]);
});

test("restores the settled state when compaction is aborted", async () => {
  const states: string[] = [];
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    async () => false,
    () => {},
  );
  const abort = new AbortController();

  await lifecycle.compactionStarted(abort.signal);
  abort.abort();
  await Promise.resolve();

  expect(states).toEqual(["working", "idle"]);
});
