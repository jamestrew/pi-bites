import { expect, test, vi } from "vitest";
import { createAgentToolExecute } from "../agent-tool-execute.js";
import { runAsSubagent } from "../subagent-context.js";

const inside = { provider: "test", id: "inside", name: "Inside", reasoning: false };
const outside = { provider: "test", id: "outside", name: "Outside", reasoning: false };

function harness(
  scopedModels: Array<{ model: typeof inside; thinkingLevel?: "high" }> = [],
  parentAgentType?: string,
) {
  const notify = vi.fn();
  const spawn = vi.fn(() => "agent-1");
  const createExecute = () =>
    createAgentToolExecute({
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
  const execute = parentAgentType ? runAsSubagent(parentAgentType, createExecute) : createExecute();
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
      agent_type: string | undefined;
      fork_context: boolean;
      reasoning_effort: string;
    }> = {},
  ) =>
    execute(
      "call",
      {
        agent_type: "worker",
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

test("omitted agent_type uses default and derives display metadata from the message", async () => {
  const runtime = harness();
  const result = await runtime.run(undefined, { agent_type: undefined });

  expect(runtime.spawn).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "default",
    "check scope",
    expect.objectContaining({ description: "check scope" }),
  );
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    agent_id: "agent-1",
    nickname: "check scope",
  });
});

test("rejects an explicit role on a full-history fork", async () => {
  const runtime = harness();
  const rejected = await runtime.run(undefined, { fork_context: true });

  expect(rejected.content[0]?.text).toContain("inherit the parent agent type");
  expect(runtime.spawn).not.toHaveBeenCalled();
});

test("a full-history fork inherits the parent agent type", async () => {
  const runtime = harness([], "explorer");

  await runtime.run(undefined, { agent_type: undefined, fork_context: true });

  expect(runtime.spawn).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "explorer",
    "check scope",
    expect.objectContaining({ forkContext: true }),
  );
});

test("rejects an unsupported reasoning effort without spawning", async () => {
  const runtime = harness();

  const result = await runtime.run(undefined, { reasoning_effort: "extreme" });

  expect(result.content[0]?.text).toContain("Unsupported reasoning_effort 'extreme'");
  expect(runtime.spawn).not.toHaveBeenCalled();
});
