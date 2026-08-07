import { beforeEach, expect, test, vi } from "vitest";
import { createAgentToolExecute } from "../agent-tool-execute.js";
import { registerAgents } from "../agent-types.js";
import type { AgentConfig } from "../types.js";

const inside = { provider: "test", id: "inside", name: "Inside", reasoning: false };
const outside = { provider: "test", id: "outside", name: "Outside", reasoning: false };

function config(name: string, model?: string): AgentConfig {
  return {
    name,
    description: "test agent",
    extensions: false,
    skills: false,
    systemPrompt: "test",
    promptMode: "replace",
    runInBackground: true,
    ...(model ? { model } : {}),
  };
}

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
    reloadCustomAgents: vi.fn(),
    isScopeModelsEnabled: () => true,
    getDefaultJoinMode: () => "async",
    trackSpawned: vi.fn(),
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
  const run = (subagentType: string, model?: string) =>
    execute(
      "call",
      {
        subagent_type: subagentType,
        description: "check scope",
        prompt: "run",
        run_in_background: true,
        ...(model ? { model } : {}),
      },
      undefined,
      undefined,
      ctx,
    );
  return { notify, run, spawn };
}

beforeEach(() => registerAgents(new Map([["inherited", config("inherited")]])));

test("caller-selected out-of-scope models return the resolved allowed models", async () => {
  const { run, spawn } = harness([{ model: inside, thinkingLevel: "high" }]);

  const result = await run("inherited", "test/outside");

  expect(result.content[0]?.text).toContain('Model not in scope: "test/outside"');
  expect(result.content[0]?.text).toContain("  test/inside");
  expect(spawn).not.toHaveBeenCalled();
});

test("upstream-resolved scoped entries allow their model regardless of pinned thinking", async () => {
  const runtime = harness([{ model: outside, thinkingLevel: "high" }]);

  await runtime.run("inherited", "test/outside");

  expect(runtime.spawn).toHaveBeenCalledOnce();
  expect(runtime.notify).not.toHaveBeenCalled();
});

test("frontmatter and inherited out-of-scope models warn and proceed", async () => {
  registerAgents(
    new Map([
      ["pinned", config("pinned", "test/outside")],
      ["inherited", config("inherited")],
    ]),
  );
  const runtime = harness([{ model: inside }]);

  await runtime.run("pinned");
  await runtime.run("inherited");

  expect(runtime.notify).toHaveBeenCalledTimes(2);
  expect(runtime.notify).toHaveBeenCalledWith(
    expect.stringContaining("out-of-scope model"),
    "warning",
  );
  expect(runtime.spawn).toHaveBeenCalledTimes(2);
});

test("empty upstream scope leaves model selection unrestricted", async () => {
  const runtime = harness();

  await runtime.run("inherited", "test/outside");

  expect(runtime.spawn).toHaveBeenCalledOnce();
  expect(runtime.notify).not.toHaveBeenCalled();
});
