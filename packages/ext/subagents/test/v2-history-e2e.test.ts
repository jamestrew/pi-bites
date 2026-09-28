import { getCurrentTools } from "@earendil-works/pi-ai";
/** Direct tools through the real manager, runner, Pi history and provider boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  getApiProvider,
  getModel,
  registerFauxProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { harness } from "./helpers/v2-harness.js";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it.each([
  { fork_turns: "all", codeMode: false },
  { fork_turns: "none", codeMode: false },
  { fork_turns: "1", codeMode: false },
  { fork_turns: "all", codeMode: true },
])(
  "replays $fork_turns history with additive instructions (Code Mode: $codeMode)",
  async ({ fork_turns, codeMode }) => {
    const cwd = mkdtempSync(join(tmpdir(), "v2-history-"));
    const faux = registerFauxProvider({
      provider: "v2-faux",
      models: [{ id: codeMode ? "gpt-6" : "test-model", contextWindow: 200_000 }],
    });
    const model = faux.getModel();
    const requests: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("CANNED ANSWER");
      },
    ]);
    const h = harness(cleanup);
    cleanup.push(async () => {
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    });
    const provider = {
      api: faux.api,
      baseUrl: model.baseUrl,
      apiKey: "faux",
      models: [model],
      streamSimple: getApiProvider(faux.api)!.streamSimple,
    };
    if (codeMode)
      h.pi.getActiveTools = () => [
        "spawn_agent",
        "list_agents",
        "read",
        "bash",
        "exec",
        "wait",
        "exec_command",
        "write_stdin",
      ];
    h.pi.exec = async () => ({ code: 1, stdout: "", stderr: "" });
    h.ctx.cwd = cwd;
    const parentModel = fork_turns === "1" ? getModel("anthropic", "claude-sonnet-4-5") : model;
    h.ctx.model = parentModel;
    h.ctx.getSystemPrompt = () =>
      "PROJECT POLICY: never widen permission. SKILL POLICY: stay bounded.";
    h.ctx.modelRegistry = {
      ...h.ctx.modelRegistry,
      getAvailable: () => [model, parentModel],
      getRegisteredProviderIds: () => [model.provider],
      getRegisteredProviderConfig: () => provider,
    };
    h.ctx.sessionManager.appendMessage({
      role: "user",
      content: "recent instruction",
      timestamp: 2,
    });
    h.ctx.sessionManager.appendMessage({
      ...fauxAssistantMessage(""),
      provider: parentModel.provider,
      api: parentModel.api,
      model: parentModel.id,
      content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "x" } }],
    });
    h.ctx.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text", text: "saved read result" }],
      isError: false,
      timestamp: 2,
    });
    // A spawn snapshot includes its own assistant call before the tool result exists.
    h.ctx.sessionManager.appendMessage({
      ...fauxAssistantMessage(""),
      provider: parentModel.provider,
      api: parentModel.api,
      model: parentModel.id,
      content: [
        {
          type: "toolCall",
          id: "spawn-call",
          name: "spawn_agent",
          arguments: { task_name: "work", message: "inspect" },
        },
      ],
    });
    const parentBefore = structuredClone(h.ctx.sessionManager.getEntries());
    const parentId = h.ctx.sessionManager.getSessionId();
    await h.emit("session_start");
    const result = await h.call("spawn_agent", {
      task_name: "work",
      message: "inspect",
      fork_turns,
      agent_type: "explorer",
      model: `${model.provider}/${model.id}`,
      reasoning_effort: "low",
    });
    expect(result.value).toEqual({ task_name: "/root/work" });
    const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
    await manager.waitForAll();
    expect((await h.call("list_agents", {})).value.agents).toContainEqual({
      agent_name: "/root/work",
      agent_status: { completed: "CANNED ANSWER" },
    });
    expect(h.ctx.sessionManager.getSessionId()).toBe(parentId);
    expect(h.ctx.sessionManager.getEntries()).toEqual(parentBefore);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(JSON.stringify(request)).toContain("PROJECT POLICY");
    expect(JSON.stringify(request)).toContain("SKILL POLICY");
    expect(JSON.stringify(request)).toContain("Your canonical task_name is /root/work.");
    const tools = getCurrentTools(request.messages)
      .map((t) => t.name)
      .sort();
    expect(tools).toEqual(
      codeMode
        ? ["exec", "list_agents", "spawn_agent", "wait"]
        : ["list_agents", "read", "spawn_agent"],
    );
    expect(JSON.stringify(request.messages)).not.toContain("multi_agent_v1__");
    expect(JSON.stringify(request.messages).includes("remember")).toBe(fork_turns === "all");
    expect(JSON.stringify(request.messages).includes("recent instruction")).toBe(
      fork_turns !== "none",
    );
    for (const [provider, api] of [
      ["anthropic", "anthropic-messages"],
      ["openai", "openai-responses"],
    ] as const) {
      const replay = transformMessages(request.messages, {
        ...model,
        provider,
        api,
        id: "cross-provider",
      });
      const results = replay.filter((m) => m.role === "toolResult");
      expect(results.map((m) => m.toolCallId)).toEqual(
        fork_turns !== "none" ? ["read-call", "spawn-call"] : [],
      );
      if (fork_turns !== "none") {
        expect(results[0]?.content).toEqual([{ type: "text", text: "saved read result" }]);
        expect(results[1]?.isError).toBe(true);
      }
    }
  },
);
