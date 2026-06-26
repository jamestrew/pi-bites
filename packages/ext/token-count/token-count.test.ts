import { expect, test } from "vitest";

import { formatCodexUsage, normalizeCodexUsage } from "./index.js";

test("formatCodexUsage renders used percent and reset duration", () => {
  expect(
    formatCodexUsage({
      capturedAt: 0,
      windows: [
        { usedPercent: 0, limitWindowSeconds: 18_000, resetAfterSeconds: 17_640 },
        { usedPercent: 3, limitWindowSeconds: 604_800, resetAfterSeconds: 231_480 },
      ],
    }),
  ).toBe("codex: 5h: 0% (4.9h) 7d: 3% (2d16.3h)");
});

test("normalizeCodexUsage preserves Codex rate limit window fields", () => {
  const usage = normalizeCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 7,
        limit_window_seconds: 18_000,
        reset_after_seconds: 16_083,
      },
      secondary_window: {
        used_percent: 16,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_063,
      },
    },
  });

  expect(usage.windows).toEqual([
    { usedPercent: 7, limitWindowSeconds: 18_000, resetAfterSeconds: 16_083 },
    { usedPercent: 16, limitWindowSeconds: 604_800, resetAfterSeconds: 86_063 },
  ]);
});
