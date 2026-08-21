import { describe, expect, test, vi } from "vitest";
import registerAutoCompaction, { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "./auto-compaction.js";

function setup(thresholdTokens?: number) {
  const handlers = new Map<string, (...args: never[]) => void>();
  const compact = vi.fn();
  let tokens: number | null = 0;
  const sendMessage = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    sendMessage,
  };
  const configRef = {
    current: thresholdTokens === undefined ? {} : { autoCompaction: { thresholdTokens } },
  };
  registerAutoCompaction(pi as never, configRef);
  let contextIsStale = false;
  const notify = vi.fn();
  const ctx = {
    getContextUsage: () => (tokens == null ? undefined : { tokens }),
    hasPendingMessages: () => false,
    compact,
    get hasUI() {
      if (contextIsStale) throw new Error("stale extension ctx");
      return true;
    },
    get ui() {
      if (contextIsStale) throw new Error("stale extension ctx");
      return { notify };
    },
  };

  return {
    compact,
    notify,
    sendMessage,
    invalidateContext: () => (contextIsStale = true),
    setTokens: (value: number | null) => (tokens = value),
    turnEnd: (hasToolCall = false) =>
      handlers.get("turn_end")?.(
        {
          message: {
            role: "assistant",
            content: hasToolCall ? [{ type: "toolCall" }] : [],
          },
        } as never,
        ctx as never,
      ),
    agentSettled: () => handlers.get("agent_settled")?.({} as never, ctx as never),
  };
}

describe("auto compaction", () => {
  test("compacts once when the threshold is crossed between tool-loop turns", () => {
    const { agentSettled, compact, setTokens, turnEnd } = setup();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD - 1);
    turnEnd();
    expect(compact).not.toHaveBeenCalled();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD);
    turnEnd();
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  test("resumes an interrupted tool loop after compaction", () => {
    const { compact, sendMessage, setTokens, turnEnd } = setup();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD);
    turnEnd(true);
    expect(sendMessage).not.toHaveBeenCalled();

    compact.mock.calls[0]?.[0].onComplete();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "auto-compaction-continuation",
        content: "Continue the previous task after compaction.",
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  test("compacts at the default fixed threshold after the agent settles", () => {
    const { compact, setTokens, agentSettled } = setup();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD - 1);
    agentSettled();
    expect(compact).not.toHaveBeenCalled();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD);
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  test("does not recompact while usage is unknown or below the threshold", () => {
    const { compact, setTokens, agentSettled } = setup(42_000);

    setTokens(42_000);
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);

    setTokens(null);
    compact.mock.calls[0]?.[0].onComplete();
    agentSettled();
    setTokens(41_999);
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  test("allows a later retry after compaction fails", () => {
    const { compact, setTokens, agentSettled } = setup(42_000);

    setTokens(42_000);
    agentSettled();
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);

    compact.mock.calls[0]?.[0].onError(new Error("failed"));
    agentSettled();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  test("handles compaction failure after its extension context becomes stale", () => {
    const { compact, notify, invalidateContext, setTokens, agentSettled } = setup(42_000);

    setTokens(42_000);
    agentSettled();
    invalidateContext();

    expect(() => compact.mock.calls[0]?.[0].onError(new Error("failed"))).not.toThrow();
    expect(notify).toHaveBeenLastCalledWith("Compaction failed: failed", "error");
  });
});
