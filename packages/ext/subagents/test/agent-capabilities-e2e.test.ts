import { execFileSync } from "node:child_process";
/** Ref #306: a parent's Code Mode projection is not its delegation permission set. */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createEventBus, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdapterToolState,
  getDelegationTools,
  NESTED_TOOLS,
  reconcileTools,
} from "../../codex-adapter/activation.js";
import { openAgentSession } from "../agent-runner.js";
import { onSubagentApprovalRequest } from "../../bash-gate/events.js";
import { EXTENSION_NAMES } from "../../config.js";
import { shutdownAgentSession } from "../agent-session-shutdown.js";

vi.setConfig({ testTimeout: 30_000 });

const CORE = ["read", "bash", "edit", "write"];
const INITIAL = [...CORE, ...NESTED_TOOLS, "codemode"];

describe("delegated Code Mode capabilities (real embedded child)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let child: AgentSession | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "agent-capabilities-e2e-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [
        { id: "gpt-6.1-sol", contextWindow: 200_000 },
        { id: "gpt-6", contextWindow: 200_000 },
        { id: "faux-1", contextWindow: 200_000 },
      ],
    });
  });

  afterEach(async () => {
    try {
      if (child) await shutdownAgentSession(child);
    } finally {
      child = undefined;
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  async function open(modelId = "gpt-6.1-sol", allowedTools?: string[], extra = {}) {
    const parentModel = faux.getModel("gpt-6.1-sol")!;
    child = await openAgentSession(
      {
        cwd,
        sessionId: "parent",
        systemPrompt: "PARENT",
        model: parentModel,
        availableModels: [parentModel, faux.getModel("faux-1")!],
        providers: [
          [
            "faux",
            {
              api: "openai-responses",
              apiKey: "fixture-only",
              baseUrl: "http://localhost",
              models: ["gpt-6.1-sol", "gpt-6", "faux-1"].map((id) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 200_000,
                maxTokens: 128,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            },
          ],
        ],
      },
      "worker",
      {
        pi: {
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          events: createEventBus(),
        } as unknown as Parameters<typeof openAgentSession>[2]["pi"],
        agentId: "capabilities-e2e",
        model: faux.getModel(modelId)!,
        allowedTools,
        ...extra,
      },
    );
    return child;
  }

  function configure(disable: string[] = [], rules: unknown[] = []) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-bites.json"),
      JSON.stringify({
        disable: [
          ...EXTENSION_NAMES.filter((name) => !["codexAdapter", "bashGate"].includes(name)),
          ...disable,
        ],
        bashGate: { rules },
      }),
    );
  }

  async function call(name: string, args: import("@earendil-works/pi-ai").JsonObject) {
    const session = child!;
    const id = crypto.randomUUID();
    let turns = 0;
    session.agent.streamFunction = (model) =>
      response(
        model,
        turns++ === 0
          ? [{ type: "toolCall", id, name, arguments: args }]
          : [{ type: "text", text: "done" }],
      );
    await session.prompt("run");
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);
    expect(result).toBeDefined();
    if (!result || result.role !== "toolResult") throw new Error("Missing tool result");
    return {
      ...result,
      text: result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    };
  }
  const run = (code: string) => call("codemode", { code });

  it.each([
    { modelId: "gpt-6", omitted: [] },
    { modelId: "faux-1", omitted: [] },
    { modelId: "gpt-6", omitted: ["edit", "write"] },
    { modelId: "faux-1", omitted: ["edit", "write"] },
    { modelId: "gpt-6", omitted: ["apply_patch"] },
    { modelId: "faux-1", omitted: ["apply_patch"] },
  ])("initializes $modelId with parent restrictions $omitted", async ({ modelId, omitted }) => {
    const initial = INITIAL.filter((name) => !omitted.includes(name));
    const state = createAdapterToolState();
    const projected = reconcileTools(initial, true, state);
    expect(projected).toContain("codemode");
    expect(projected).not.toContain("read");
    expect(projected).not.toContain("bash");

    const allowedTools = getDelegationTools(projected, state);
    const onToolActivity = vi.fn();
    await open(modelId, allowedTools, { onToolActivity });

    expect(onToolActivity).not.toHaveBeenCalled();
    expect(child!.model?.id).toBe(modelId);
    expect(child!.messages).toEqual([]); // Initialization only: no prompt or provider request.
    const active = child!.getActiveToolNames();
    expect(active).not.toContain("MessageAgent");
    expect(active).not.toContain("spawn_agent");
    expect(active).not.toContain("wait_agent");
    for (const name of omitted) {
      expect(allowedTools).not.toContain(name);
      expect(active).not.toContain(name);
    }

    if (modelId === "gpt-6") {
      expect(active).toEqual(expect.arrayContaining(["codemode"]));
      expect(active).not.toContain("bash");
      const description = child!.agent.state.tools.find((t) => t.name === "codemode")!.description;
      // Pi prepares model-facing declarations from the callable registry.
      // web_run also requires provider credentials, intentionally absent here.
      for (const name of ["exec_command", "write_stdin", "view_image"])
        expect(description).toContain(name);
      if (omitted.length === 0) expect(description).toContain("apply_patch");
      else expect(description).not.toContain("apply_patch");
      if (omitted.includes("apply_patch"))
        expect(active).toEqual(expect.arrayContaining(["edit", "write"]));
    } else {
      expect(active).toEqual(
        expect.arrayContaining(CORE.filter((name) => !omitted.includes(name))),
      );
      expect(active).not.toContain("exec");
      expect(active).not.toContain("wait");
      expect(active).not.toContain("codemode");
      for (const name of NESTED_TOOLS) expect(active).not.toContain(name);
    }
  });
  it("loads embedded SDK native factories without duplicate tool errors", async () => {
    configure();
    await open();
    expect(child!.resourceLoader.getExtensions().errors).toEqual([]);
    await child!.reload();
    expect(child!.resourceLoader.getExtensions().errors).toEqual([]);
  });

  it("discovers and executes typed native shell values host-free, then polls a resumable shell", async () => {
    configure();
    const pi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      events: createEventBus(),
    } as any;
    const approve = vi.fn(
      async (_request: import("../../bash-gate/events.js").ApprovalRequest) => ({
        outcome: "allow" as const,
        authorization: "human-approved" as const,
      }),
    );
    const unsubscribe = onSubagentApprovalRequest(pi, approve);
    await open(undefined, [...INITIAL, "tool_search"], { pi });
    const search = await call("tool_search", { query: "exec_command", limit: 1 });
    expect(search.isError, search.text).toBe(false);
    expect(child!.getActiveToolNames()).toContain("exec_command");
    const delayed = `${execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim()} 0.5; printf later`;
    vi.stubEnv("PATH", "/no-code-mode-host");
    try {
      const start = await run(
        `text(await searchTools('exec_command')); text(await describeTool('exec_command')); text(await tools.exec_command({cmd:'printf allowed; exit 7',shell:'/bin/sh',login:false})); store('shell',await tools.exec_command({cmd:${JSON.stringify(delayed)},shell:'/bin/sh',login:false,yield_time_ms:250})); text(load('shell'));`,
      );
      expect(start.isError, start.text).toBe(false);
      expect(start.text).toContain('"output":"allowed"');
      expect(start.text).toContain('"exit_code":7');
      expect(start.text).toContain('"session_id"');
      const poll = await run(
        `text(await tools.write_stdin({session_id:load('shell').session_id}));`,
      );
      expect(poll.isError, poll.text).toBe(false);
      expect(poll.text).toContain('"output":"later"');
      expect(poll.text).toContain('"exit_code":0');
      expect(approve.mock.calls.map(([request]) => request.command)).toEqual([
        "printf allowed; exit 7",
        delayed,
      ]);
    } finally {
      unsubscribe();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["read", "codemode", "tool_search"],
    [...CORE, "codemode", "tool_search", "exec_command", "write_stdin"],
  ])(
    "keeps SDK selection ceilings through discovery, search, switches and reload: %j",
    async (...allowedTools) => {
      configure();
      await open(undefined, allowedTools);
      const assertCeiling = async () => {
        const result = await run(
          `text(ALL_TOOLS.map(t=>t.name)); text(await searchTools('apply_patch web_run view_image')); text(await describeTool('apply_patch'));`,
        );
        expect(result.isError, result.text).toBe(false);
        for (const name of ["apply_patch", "web_run", "view_image"]) {
          expect(result.text).not.toContain(name);
          expect(child!.getCallableToolNames()).not.toContain(name);
        }
        expect(
          (
            await run(
              `await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** End Patch")});`,
            )
          ).isError,
        ).toBe(true);
        const search = await call("tool_search", {
          query: "apply_patch web_run view_image",
          limit: 10,
        });
        expect(search.isError, search.text).toBe(false);
        for (const name of ["apply_patch", "web_run", "view_image"])
          expect(search.text).not.toContain(name);
        if (!allowedTools.includes("bash")) {
          expect(child!.getCallableToolNames()).not.toContain("exec_command");
          expect((await run(`await tools.exec_command({cmd:'touch forbidden'});`)).isError).toBe(
            true,
          );
        }
      };
      await assertCeiling();
      await child!.setModel(faux.getModel("faux-1")!);
      expect(child!.getActiveToolNames()).not.toContain("codemode");
      await child!.setModel(faux.getModel("gpt-6.1-sol")!);
      await assertCeiling();
      await child!.reload();
      await assertCeiling();
      expect(child!.getToolDefinition("spawn_agent")).toBeUndefined();
    },
  );

  it("registered but inactive owned capabilities remain hidden across availability and adapter changes", async () => {
    configure();
    await open(undefined, [...INITIAL, "tool_search"]);
    await child!.setModel({ ...faux.getModel("gpt-6.1-sol")!, input: ["text"] });
    const hidden = await run(
      `text(ALL_TOOLS.map(t=>t.name)); text(await searchTools('web_run view_image'));`,
    );
    expect(hidden.isError, hidden.text).toBe(false);
    for (const name of ["web_run", "view_image"]) {
      expect(hidden.text).not.toContain(name);
      expect(child!.getToolDefinition(name)).toBeDefined();
      expect(child!.getCallableToolNames()).not.toContain(name);
    }
    const search = await call("tool_search", { query: "web_run view_image", limit: 10 });
    expect(search.isError, search.text).toBe(false);
    expect(child!.getActiveToolNames()).not.toContain("view_image");
    configure(["codexAdapter"]);
    await child!.reload();
    expect(child!.getActiveToolNames()).toEqual(expect.arrayContaining(CORE));
    expect(child!.getActiveToolNames()).not.toContain("codemode");
    for (const name of NESTED_TOOLS) expect(child!.getCallableToolNames()).not.toContain(name);
    expect(
      (await call("tool_search", { query: "exec_command apply_patch", limit: 10 })).text,
    ).not.toContain('"name":"exec_command"');
    await child!.setModel(faux.getModel("gpt-6.1-sol")!);
    expect(child!.getActiveToolNames()).not.toContain("codemode");
    expect(child!.getCallableToolNames()).not.toContain("exec_command");
  });

  it.each(["abort", "shutdown"] as const)(
    "%s invalidates late child approval and throwing stale contexts",
    async (mode) => {
      configure([], [{ cmd: "touch" }]);
      const pi = {
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        events: createEventBus(),
      } as any;
      const choice =
        Promise.withResolvers<import("../../bash-gate/events.js").BashGateApprovalResult>();
      const approve = vi.fn(() => choice.promise);
      const unsubscribe = onSubagentApprovalRequest(pi, approve);
      await open(undefined, INITIAL, { pi });
      const oldContext = child!.extensionRunner.createContext();
      try {
        const pending = run(`await tools.exec_command({cmd:'touch forbidden',login:false});`);
        await expect.poll(() => approve.mock.calls.length).toBe(1);
        if (mode === "shutdown") {
          await shutdownAgentSession(child!);
          child = undefined;
        } else {
          await child!.abort();
          await child!.reload();
        }
        await pending;
        expect(() => oldContext.cwd).toThrow();
        choice.resolve({ outcome: "allow", authorization: "human-approved" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(existsSync(join(cwd, "forbidden"))).toBe(false);
        if (child) expect((await run(`text('replacement');`)).text).toContain("replacement");
      } finally {
        unsubscribe();
      }
    },
  );

  it("reload retires child shells/store and recovered history never revives them", async () => {
    configure();
    const pi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      events: createEventBus(),
    } as any;
    const unsubscribe = onSubagentApprovalRequest(pi, async () => ({
      outcome: "allow",
      authorization: "human-approved",
    }));
    await open(undefined, INITIAL, { pi });
    const started = await run(
      `store('old',await tools.exec_command({cmd:'echo $$ > owned.pid; sleep 60',login:false,yield_time_ms:250}));text(load('old'));`,
    );
    expect(started.isError, started.text).toBe(false);
    const pid = Number(readFileSync(join(cwd, "owned.pid"), "utf8").trim());
    await child!.reload();
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect((await run(`text(load('old'));`)).text).not.toContain("session_id");
    const entries = child!.sessionManager.getEntries();
    const sessionId = child!.sessionManager.getSessionId();
    await shutdownAgentSession(child!);
    child = undefined;
    await open(undefined, INITIAL, { conversation: { sessionId, cwd, entries } });
    expect((await run(`text(load('old'));`)).text).not.toContain("session_id");
    unsubscribe();
  });

  it("adapter-disabled SDK children retain ordinary tools", async () => {
    configure(["codexAdapter"]);
    const session = await open();
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(CORE));
    expect(session.getActiveToolNames()).not.toContain("codemode");
    expect(session.getCallableToolNames()).not.toContain("exec_command");
  });
});

function response(model: Parameters<StreamFunction>[0], content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  const stopReason = content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}
