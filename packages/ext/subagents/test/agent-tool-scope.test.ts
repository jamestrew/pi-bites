import { expect, test, vi } from "vitest";
import { createSpawnExecution } from "../agent-tool-execute.js";
import { resolveAgent } from "../agent-types.js";

const inside = { provider: "test", id: "inside", name: "Inside", reasoning: true };
const outside = { provider: "test", id: "outside", name: "Outside", reasoning: true };

function harness(scopedModels: Array<{ model: typeof inside; thinkingLevel?: "high" }> = []) {
  const notify = vi.fn();
  const spawn = vi.fn(() => "agent-1");
  const createExecute = () =>
    createSpawnExecution(
      {
        pi: { getThinkingLevel: () => "off" } as never,
        manager: {
          spawn,
          getRecord: () => undefined,
          getMaxConcurrent: () => 2,
        } as never,
        agentActivity: new Map(),
        fleet: { ensureTimer: vi.fn(), update: vi.fn() } as never,
        isScopeModelsEnabled: () => true,
      },
      spawn,
    );
  const execute = createExecute();
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
  const run = (
    model?: string,
    overrides: Partial<{
      message: string;
      agent: ReturnType<typeof resolveAgent>;
      agent_type: string | undefined;
      forkContext: boolean;
      reasoning_effort: string;
    }> = {},
  ) =>
    execute(
      "call",
      {
        agent: resolveAgent("worker"),
        forkContext: false,
        message: "check scope",
        ...(model ? { model } : {}),
        ...overrides,
      },
      undefined,
      undefined,
      ctx,
    );
  return { notify, run, spawn };
}

test("caller-selected out-of-scope models throw with the resolved allowed models", async () => {
  const { run, spawn } = harness([{ model: inside, thinkingLevel: "high" }]);

  await expect(run("test/outside")).rejects.toMatchObject({
    name: "SubagentOperationError",
    message: expect.stringMatching(/Model not in scope: "test\/outside"[\s\S]*  test\/inside/),
    details: expect.any(Object),
  });
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

test("rejects an unsupported reasoning effort without spawning", async () => {
  const runtime = harness();

  await expect(runtime.run(undefined, { reasoning_effort: "extreme" })).rejects.toMatchObject({
    name: "SubagentOperationError",
    message: expect.stringContaining("Unsupported reasoning_effort 'extreme'"),
    details: expect.any(Object),
  });
  expect(runtime.spawn).not.toHaveBeenCalled();
});

test("role model and effort override validated explicit spawn choices", async () => {
  const runtime = harness();
  const role = resolveAgent("worker");
  const agent = { ...role, config: { ...role.config, model: "test/outside", thinking: "high" } };
  const result = await runtime.run("test/inside", { agent, reasoning_effort: "low" });
  expect(result.details).toMatchObject({ modelName: "test/outside", thinking: "high" });
  await expect(runtime.run("missing", { agent })).rejects.toThrow("Model not found");
  await expect(runtime.run("test/inside", { agent, reasoning_effort: "max" })).rejects.toThrow(
    "Unsupported reasoning_effort",
  );
});

test("role overrides cannot hide an explicit out-of-scope request", async () => {
  const runtime = harness([{ model: inside }]);
  const role = resolveAgent("worker");
  const agent = { ...role, config: { ...role.config, model: "test/inside" } };
  await expect(runtime.run("test/outside", { agent })).rejects.toThrow("Model not in scope");
});
