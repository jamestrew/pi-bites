import { registerChildSendInput } from "./helpers/child-send-input.js";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { requestSubagentApproval } from "../../bash-gate/events.js";
import { mockCtx, mockSession } from "./helpers/agent-manager-mocks.js";

vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
  openAgentSession: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../diagnostics.js", async (original) => ({
  ...(await original<typeof import("../diagnostics.js")>()),
  appendSubagentDiagnostic: vi.fn(async () => {}),
}));
import { openAgentSession, resumeAgent, runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

beforeEach(() => vi.resetAllMocks());

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const handlers = new Map<string, Set<(data: unknown) => unknown>>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: (event: string, handler: any) => lifecycle.set(event, handler),
    events: {
      emit: (event: string, data: unknown) => {
        for (const handler of handlers.get(event) ?? []) void handler(data);
      },
      on: (event: string, handler: (data: unknown) => unknown) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => {
          handlers.get(event)!.delete(handler);
        };
      },
    },
    sendMessage: vi.fn(),
    getThinkingLevel: () => "off",
    getActiveTools: () => [
      "spawn_agent",
      "send_input",
      "wait_agent",
      "close_agent",
      "resume_agent",
      "read",
    ],
  } as any;
  return { pi, tools, lifecycle };
}

it.each([false, true])(
  "requires fresh approval across reopen with delayed completion (generation mismatch: %s)",
  async (advanceGeneration) => {
    const { pi, tools, lifecycle } = makePi();
    const ui = { select: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() };
    const model = { id: "current", provider: "test", reasoning: false };
    const ctx = {
      ...mockCtx,
      hasUI: true,
      ui,
      model,
      scopedModels: [],
      modelRegistry: { ...mockCtx.modelRegistry, getAvailable: () => [model] },
    };
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx);
    await lifecycle.get("agent_start")({}, ctx);
    const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
    const child = {
      ...mockSession(),
      sessionManager: SessionManager.inMemory("/tmp"),
    };
    const finished = Promise.withResolvers<any>();
    vi.mocked(runAgent).mockImplementationOnce((_parent, _type, _prompt, options) => {
      options.onSessionCreated?.(child);
      return finished.promise;
    });
    try {
      const id = manager.spawn(pi, ctx, "worker", "work", { description: "approval regression" });
      // A queued intermediate message holds completion delivery until the parent settles.
      const sendInput = registerChildSendInput(vi.mocked(runAgent).mock.calls.at(-1)![3], ctx);
      await expect(sendInput("progress")).resolves.toMatchObject({ details: { status: "queued" } });
      const oldRecord = manager.getRecord(id);
      const oldIncarnation = vi.mocked(runAgent).mock.calls.at(-1)![3].agentSessionId;
      expect(oldIncarnation).toEqual(expect.any(String));
      const approve = (agentSessionId: string | undefined) =>
        requestSubagentApproval(pi, {
          execution: { cwd: "/repo" },
          agentId: id,
          agentSessionId,
          title: "worker",
          command: "rm build.txt",
          labels: ["rm"],
          reasons: [],
          sessionAllowKey: "rm",
        });
      const allowed = { outcome: "allow-session", authorization: "human-approved" };
      const denied = { outcome: "deny", source: "manual" };
      ui.select.mockResolvedValue('Allow for session ("rm")');
      expect(await approve(oldIncarnation)).toEqual(allowed);
      expect(await approve(oldIncarnation)).toEqual(allowed);
      expect(ui.select).toHaveBeenCalledTimes(1);

      finished.resolve({ session: child, responseText: "done" });
      await oldRecord.promise;
      expect(pi.sendMessage).not.toHaveBeenCalled();
      await manager.close(id);
      ui.select.mockResolvedValue("Deny");
      expect(await approve(oldIncarnation)).toEqual(denied);
      expect(ui.select).toHaveBeenCalledTimes(2);

      vi.mocked(openAgentSession).mockResolvedValueOnce({
        ...mockSession(),
        sessionManager: child.sessionManager,
      });
      await tools.get("resume_agent").execute("reopen", { id }, undefined, undefined, ctx);
      const incarnation = vi.mocked(openAgentSession).mock.calls.at(-1)![2].agentSessionId;
      expect(incarnation).toEqual(expect.any(String));
      expect(incarnation).not.toBe(oldIncarnation);
      expect(await approve(incarnation)).toEqual(denied);
      expect(ui.select).toHaveBeenCalledTimes(3);

      if (advanceGeneration) {
        // The first input starts the idle reopen's generation; the second advances it.
        for (let turn = 0; turn < 2; turn++) {
          vi.mocked(resumeAgent).mockResolvedValueOnce("next turn");
          const result = await tools
            .get("send_input")
            .execute("input", { target: id, message: "continue" }, undefined, undefined, ctx);
          expect(result.details.status).toBe("queued");
          await manager.getRecord(id).promise;
        }
      }
      expect(manager.getRecord(id).generation === oldRecord.generation).toBe(!advanceGeneration);
      ui.select.mockResolvedValue('Allow for session ("rm")');
      expect(await approve(incarnation)).toEqual(allowed);
      expect(ui.select).toHaveBeenCalledTimes(4);
      expect(pi.sendMessage).not.toHaveBeenCalled();

      await lifecycle.get("agent_settled")({}, { ...ctx, isIdle: () => true });
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-notification" }),
        expect.anything(),
      );
      // Delivering the old completion must not erase this incarnation's new approval.
      expect(await approve(incarnation)).toEqual(allowed);
      expect(ui.select).toHaveBeenCalledTimes(4);
    } finally {
      finished.resolve({ session: child, responseText: "cleanup" });
      await lifecycle.get("session_shutdown")({}, ctx);
    }
  },
);
