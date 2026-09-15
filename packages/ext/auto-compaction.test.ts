import { describe, expect, test, vi } from "vitest";
import registerAutoCompaction, {
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
  installTurnBoundaryAutoCompaction,
} from "./auto-compaction.js";

function setup(thresholdTokens?: number, mode = "tui") {
  const handlers = new Map<string, (...args: never[]) => void>();
  const compact = vi.fn();
  const run = new AbortController();
  const abort = vi.fn(() => run.abort());
  const sendMessage = vi.fn();
  let apiIsStale = false;
  let tokens: number | null = 0;
  const pi = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    sendMessage: (...args: unknown[]) => {
      if (apiIsStale) throw new Error("stale extension API");
      sendMessage(...args);
    },
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
    signal: run.signal,
    abort,
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
    abort,
    notify,
    sendMessage,
    signal: run.signal,
    cancelRun: () => run.abort(),
    invalidateApi: () => (apiIsStale = true),
    invalidateContext: () => (contextIsStale = true),
    setTokens: (value: number | null) => (tokens = value),
    turnEnd: (hasToolCall = false) =>
      handlers.get("turn_end")?.(
        {
          message: {
            role: "assistant",
            content: hasToolCall ? [{ type: "toolCall" }] : [],
          },
          toolResults: [],
        } as never,
        ctx as never,
      ),
    agentSettled: () => handlers.get("agent_settled")?.({} as never, ctx as never),
  };
}

describe("auto compaction", () => {
  test("stops, compacts, and resumes a tool loop at the configured threshold", () => {
    const { abort, agentSettled, compact, sendMessage, setTokens, turnEnd } = setup(42_000);

    setTokens(41_999);
    turnEnd();
    expect(compact).not.toHaveBeenCalled();

    setTokens(42_000);
    turnEnd(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(compact).not.toHaveBeenCalled();

    agentSettled();
    expect(compact).toHaveBeenCalledTimes(1);

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

  test("does not resume a tool loop canceled before its turn ended", () => {
    const { abort, agentSettled, cancelRun, compact, sendMessage, setTokens, turnEnd } = setup();

    setTokens(DEFAULT_AUTO_COMPACTION_THRESHOLD);
    cancelRun();
    turnEnd(true);
    expect(abort).not.toHaveBeenCalled();

    agentSettled();
    compact.mock.calls[0]?.[0].onComplete();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test.each(["print", "json"])("leaves %s-mode tool loops to Pi's overflow compaction", (mode) => {
    const { agentSettled, compact, setTokens, turnEnd } = setup(1, mode);

    setTokens(100);
    turnEnd(true);
    agentSettled();

    expect(compact).not.toHaveBeenCalled();
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

  test("ignores a continuation after its extension API becomes stale", () => {
    const { agentSettled, compact, invalidateApi, sendMessage, setTokens, turnEnd } = setup(42_000);

    setTokens(42_000);
    turnEnd(true);
    agentSettled();
    invalidateApi();

    expect(() => compact.mock.calls[0]?.[0].onComplete()).not.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
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
