import { afterEach, expect, it, vi } from "vitest";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { harness } from "./helpers/v2-harness.js";
import { mockSession, waitForCancellation } from "./helpers/agent-manager-mocks.js";

vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
}));
import { runAgent } from "../agent-runner.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.clearAllMocks();
});

async function fork(h: ReturnType<typeof harness>, fork_turns: string) {
  vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
    options.onSessionCreated?.(mockSession());
    return waitForCancellation(options.signal);
  });
  const before = structuredClone(h.ctx.sessionManager.getEntries());
  await h.call("spawn_agent", { task_name: "work", message: "inspect", fork_turns });
  expect(h.ctx.sessionManager.getEntries()).toEqual(before);
  const entries = vi.mocked(runAgent).mock.calls[0]![3].parentEntries!;
  return SessionManager.inMemory("/tmp", {}, entries);
}

it.each(["1", "2", "99"])(
  "imports %s recent tasks after compaction and edits through stock provider conversion",
  async (fork_turns) => {
    const h = harness(cleanup);
    const parent: SessionManager = h.ctx.sessionManager;
    const anthropic = getModel("anthropic", "claude-sonnet-4-5");
    const openai = getModel("openai", "gpt-5");
    const toolCall = (id: string) => {
      const source = id === "first-call" ? openai : anthropic;
      return parent.appendMessage({
        ...fauxAssistantMessage(""),
        provider: source.provider,
        api: source.api,
        model: source.id,
        content: [
          {
            type: "thinking",
            thinking: "private reasoning",
            ...(source.provider === "anthropic"
              ? { thinkingSignature: "anthropic-signature" }
              : {}),
          },
          { type: "toolCall", id, name: "read", arguments: { path: "file" } },
        ],
      });
    };
    const toolResult = (id: string, text: string) =>
      parent.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        isError: false,
        content: [{ type: "text", text }],
        timestamp: 2,
      });
    const retainedMidTask = toolCall("pre-boundary");
    toolResult("pre-boundary", "OLDER MID-TASK RESULT");
    parent.appendMessage({ role: "user", content: "FIRST RETAINED INSTRUCTION", timestamp: 3 });
    toolCall("first-call");
    toolResult("first-call", "FIRST RESULT");
    parent.appendCustomMessageEntry("subagent-message", "TASK from /root/sibling", true, {
      sender: { id: "/root/sibling", type: "worker", title: "sibling" },
      message: "TASK",
      task: true,
    });
    parent.appendCustomMessageEntry("subagent-message", "QUEUE ONLY INFO", true, {
      message: "INFO",
    });
    toolCall("recent-call");
    const edited = toolResult("recent-call", "OBSOLETE OUTPUT");
    const omitted = toolCall("orphan-call");
    toolResult("orphan-call", "ORPHAN RESULT");
    parent.appendCompaction("OLDER SUMMARY", retainedMidTask, 1000);
    parent.appendContextEdit(edited, { content: "CORRECTED OUTPUT" });
    parent.appendContextEdit(omitted, null);
    toolCall("in-progress-spawn");

    const child = await fork(h, fork_turns);
    const messages = convertToLlm(child.buildSessionContext().messages);
    const text = JSON.stringify(messages);
    expect(text).toContain("TASK from /root/sibling");
    expect(text).toContain("QUEUE ONLY INFO");
    expect(text).toContain("CORRECTED OUTPUT");
    expect(text.includes("FIRST RETAINED INSTRUCTION")).toBe(fork_turns !== "1");
    for (const excluded of ["remember", "OLDER", "OBSOLETE", "ORPHAN"])
      expect(text).not.toContain(excluded);
    expect(
      child.getEntries().some((e) => e.type === "context_edit" || e.type === "compaction"),
    ).toBe(false);
    expect(child.getEntries().filter((e) => e.type === "custom_message")[0]).toMatchObject({
      details: { sender: { id: "/root/sibling" }, task: true },
    });
    const context = normalizeContext({ messages });
    const input = convertResponsesMessages(
      openai,
      context,
      new Set(["openai", "openai-codex", "opencode"]),
    );
    const calls = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
    const results = input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id);
    expect(calls).toEqual(
      fork_turns === "1"
        ? ["recent-call", "in-progress-spawn"]
        : ["first-call", "recent-call", "in-progress-spawn"],
    );
    expect(results).toEqual(calls);
    expect(JSON.stringify(input)).not.toContain("anthropic-signature");
    expect(JSON.stringify(input)).toContain("No result provided");

    let payload: any;
    const fetch = vi.fn(async () => {
      throw new Error("unexpected transport");
    });
    await stream(anthropic, context, {
      apiKey: "fixture-only",
      fetch: fetch as unknown as typeof globalThis.fetch,
      onPayload(value) {
        payload = structuredClone(value);
        throw new Error("stop before transport");
      },
    }).result();
    expect(fetch).not.toHaveBeenCalled();
    expect(payload).toBeDefined();
    const blocks = payload.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id)).toEqual(calls);
    expect(
      blocks.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id),
    ).toEqual(calls);
  },
);

it("inherits no partial task when compaction leaves no instruction/task boundary", async () => {
  const h = harness(cleanup);
  const parent: SessionManager = h.ctx.sessionManager;
  const midTask = parent.appendMessage(fauxAssistantMessage("only a tool-loop tail"));
  parent.appendCompaction("OLD SUMMARY", midTask, 1000);
  parent.appendCustomMessageEntry("subagent-message", "queue-only mail", true, {});
  expect((await fork(h, "99")).buildSessionContext().messages).toEqual([]);
});
