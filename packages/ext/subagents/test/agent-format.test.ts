import { describe, expect, it } from "vitest";
import { formatTurns } from "../ui/agent-format.js";

describe("formatTurns", () => {
  it("displays the raw turn count", () => {
    expect(formatTurns(5)).toBe("↻5");
  });
});
