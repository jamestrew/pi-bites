import { expect, test, vi } from "vitest";
import { createAgentToolExecute } from "../agent-tool-execute.js";

const inside = { provider: "test", id: "inside", name: "Inside", reasoning: false };
const outside = { provider: "test", id: "outside", name: "Outside", reasoning: false };

function harness(scopedModels: Array<{ model: typeof inside; thinkingLevel?: "high" }> = []) {
  const notify = vi.fn();
  const spawn = vi.fn(() => "agent-1");
  const execute = createAgentToolExecute({
    pi: { getThinkingLevel: () => "off" } as never,
    manager: {
      spawn,
      getRecord: () => undefined,
      getMaxConcurrent: () => 2,
    } as never,
    agentActivity: new Map(),
    fleet: { ensureTimer: vi.fn(), update: vi.fn() } as never,
    isScopeModelsEnabled: () => true,
  });
  const ctx = {
    cwd: "/tmp",
    model: outside,
    scopedModels,
    modelRegistry: {
      getAll: () => [inside, outside],
      getAvailable: () => [inside, outside],
      find: (provider: string, id: string) =>
        [inside, outside].find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: { getSessionId: () => "session" },
    ui: { notify },
  } as never;
  const run = (model?: string) =>
    execute(
      "call",
      {
        subagent_type: "general",
        description: "check scope",
        prompt: "run",
        ...(model ? { model } : {}),
      },
      undefined,
      undefined,
      ctx,
    );
  return { notify, run, spawn };
}

test("caller-selected out-of-scope models return the resolved allowed models", async () => {
  const { run, spawn } = harness([{ model: inside, thinkingLevel: "high" }]);

  const result = await run("test/outside");

  expect(result.content[0]?.text).toContain('Model not in scope: "test/outside"');
  expect(result.content[0]?.text).toContain("  test/inside");
  expect(spawn).not.toHaveBeenCalled();
});

test("upstream-resolved scoped entries allow their model regardless of pinned thinking", async () => {
  const runtime = harness([{ model: outside, thinkingLevel: "high" }]);

  await runtime.run("test/outside");

  expect(runtime.spawn).toHaveBeenCalledOnce();
  expect(runtime.notify).not.toHaveBeenCalled();
});

test("an inherited out-of-scope model warns and proceeds", async () => {
  const runtime = harness([{ model: inside }]);

  await runtime.run();

  expect(runtime.notify).toHaveBeenCalledWith(
    expect.stringContaining("out-of-scope model"),
    "warning",
  );
  expect(runtime.spawn).toHaveBeenCalledOnce();
});

test("empty upstream scope leaves model selection unrestricted", async () => {
  const runtime = harness();

  await runtime.run("test/outside");

  expect(runtime.spawn).toHaveBeenCalledOnce();
  expect(runtime.notify).not.toHaveBeenCalled();
});
