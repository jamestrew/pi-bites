import { expect, test } from "bun:test";
import { buildDoneStats } from "./format.js";

test("buildDoneStats renders pi-style token usage", () => {
  expect(
    buildDoneStats(
      3,
      {
        input: 16_000,
        output: 1300,
        cacheRead: 32_000,
        cacheWrite: 0,
        cost: 0.137,
        turns: 2,
      },
      12_300,
    ),
  ).toBe("3 tool uses · ↑16k ↓1.3k R32k CH66.7% $0.137 · 12.3s");
});

test("buildDoneStats only renders optional cache write and cache hit when applicable", () => {
  expect(
    buildDoneStats(1, {
      input: 42,
      output: 7,
      cacheRead: 0,
      cacheWrite: 5,
      cost: 0,
      turns: 1,
    }),
  ).toBe("1 tool use · ↑42 ↓7 W5");
});
