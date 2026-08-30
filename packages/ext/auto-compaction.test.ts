import { describe, expect, test, vi } from "vitest";
import registerAutoCompaction, {
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
  installTurnBoundaryAutoCompaction,
} from "./auto-compaction.js";

function setup(thresholdTokens?: number, mode = "tui") {
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
    mode,
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

  test.each(["print", "json"])("leaves %s-mode tool loops to Pi's overflow compaction", (mode) => {
    const { agentSettled, compact, setTokens, turnEnd } = setup(1, mode);

    setTokens(100);
    turnEnd(true);
    agentSettled();

    expect(compact).not.toHaveBeenCalled();
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

describe("subagent turn-boundary compaction", () => {
  test("replaces the next-turn context without aborting the active run", async () => {
    const compactedMessages = [{ role: "compactionSummary" }];
    const runAutoCompaction = vi.fn(async () => false);
    const session = {
      agent: {
        state: { messages: compactedMessages },
        prepareNextTurnWithContext: vi.fn(async (turn, _signal?: AbortSignal) => ({
          context: turn.context,
        })),
      },
      getContextUsage: () => ({ tokens: 42_000 }),
      abortCompaction: vi.fn(),
      _runAutoCompaction: runAutoCompaction,
    };
    installTurnBoundaryAutoCompaction(session as never, 42_000);

    const result = await session.agent.prepareNextTurnWithContext({ context: { messages: [] } });

    expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false);
    expect(result.context.messages).toEqual(compactedMessages);
    expect(session.abortCompaction).not.toHaveBeenCalled();
  });

  test("continues with the original context when automatic compaction rejects", async () => {
    const originalMessages = [{ role: "toolResult" }];
    const session = {
      agent: {
        state: { messages: [{ role: "partiallyCompacted" }] },
        prepareNextTurnWithContext: vi.fn(async (turn) => ({ context: turn.context })),
      },
      getContextUsage: () => ({ tokens: 42_000 }),
      abortCompaction: vi.fn(),
      _runAutoCompaction: vi.fn(async () => {
        throw new Error("incompatible private API");
      }),
    };
    installTurnBoundaryAutoCompaction(session as never, 42_000);

    const result = await session.agent.prepareNextTurnWithContext({
      context: { messages: originalMessages },
    });

    expect(session._runAutoCompaction).toHaveBeenCalledOnce();
    expect(result.context.messages).toBe(originalMessages);
  });

  test("forwards external cancellation to in-progress compaction", async () => {
    let finishCompaction: (() => void) | undefined;
    const session = {
      agent: {
        state: { messages: [] },
        prepareNextTurnWithContext: vi.fn(async (turn, _signal?: AbortSignal) => ({
          context: turn.context,
        })),
      },
      getContextUsage: () => ({ tokens: 42_000 }),
      subscribe: vi.fn(() => vi.fn()),
      abortCompaction: vi.fn(() => finishCompaction?.()),
      _runAutoCompaction: vi.fn(
        () => new Promise<boolean>((resolve) => (finishCompaction = () => resolve(false))),
      ),
    };
    installTurnBoundaryAutoCompaction(session as never, 42_000);
    const controller = new AbortController();

    const prepare = session.agent.prepareNextTurnWithContext as (
      turn: { context: { messages: never[] } },
      signal?: AbortSignal,
    ) => Promise<{ context: { messages: never[] } } | undefined>;
    const preparing = prepare({ context: { messages: [] } }, controller.signal);
    await vi.waitFor(() => expect(session._runAutoCompaction).toHaveBeenCalledOnce());
    controller.abort();
    await preparing;

    expect(session.abortCompaction).toHaveBeenCalledOnce();
  });

  test("cancels after compaction starts when cancellation landed during auth", async () => {
    let releaseAuth: (() => void) | undefined;
    let finishCompaction: (() => void) | undefined;
    let listener: ((event: { type: string }) => void) | undefined;
    const session = {
      agent: {
        state: { messages: [] },
        prepareNextTurnWithContext: vi.fn(async (turn, _signal?: AbortSignal) => ({
          context: turn.context,
        })),
      },
      getContextUsage: () => ({ tokens: 42_000 }),
      subscribe: vi.fn((next: (event: { type: string }) => void) => {
        listener = next;
        return vi.fn();
      }),
      abortCompaction: vi.fn(() => finishCompaction?.()),
      _runAutoCompaction: vi.fn(async () => {
        await new Promise<void>((resolve) => (releaseAuth = resolve));
        listener?.({ type: "compaction_start" });
        await new Promise<void>((resolve) => (finishCompaction = resolve));
        return false;
      }),
    };
    installTurnBoundaryAutoCompaction(session as never, 42_000);
    const controller = new AbortController();

    const preparing = session.agent.prepareNextTurnWithContext(
      { context: { messages: [] } },
      controller.signal,
    );
    await vi.waitFor(() => expect(session._runAutoCompaction).toHaveBeenCalledOnce());
    controller.abort();
    releaseAuth?.();
    await preparing;

    expect(session.abortCompaction).toHaveBeenCalledTimes(2);
  });
});
