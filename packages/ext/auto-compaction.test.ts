import { describe, expect, test, vi } from "vitest";
import registerAutoCompaction, { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "./auto-compaction.js";

function setup(thresholdTokens?: number) {
  const handlers = new Map<string, (...args: never[]) => void>();
  const compact = vi.fn();
  let tokens: number | null = 0;
  const pi = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
  };
  const configRef = {
    current: thresholdTokens === undefined ? {} : { autoCompaction: { thresholdTokens } },
  };
  registerAutoCompaction(pi as never, configRef);
  const ctx = {
    getContextUsage: () => (tokens == null ? undefined : { tokens }),
    compact,
    hasUI: true,
    ui: { notify: vi.fn() },
  };

  return {
    compact,
    setTokens: (value: number | null) => (tokens = value),
    agentSettled: () => handlers.get("agent_settled")?.({} as never, ctx as never),
  };
}

describe("auto compaction", () => {
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
});
