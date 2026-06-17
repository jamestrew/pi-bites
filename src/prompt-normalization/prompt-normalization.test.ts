import { describe, expect, test } from "bun:test";
import registerPromptNormalization, { stripTrailingHorizontalWhitespace } from "./index.js";

describe("stripTrailingHorizontalWhitespace", () => {
  test("removes trailing spaces and tabs per line while preserving indentation and blank lines", () => {
    const input = "  hello  \n\tworld\t\n\t  \n\n  indented";

    expect(stripTrailingHorizontalWhitespace(input)).toBe("  hello\n\tworld\n\n\n  indented");
  });

  test("does not trim the full prompt as a single string", () => {
    expect(stripTrailingHorizontalWhitespace("  hello  \n\n  ")).toBe("  hello\n\n");
  });
});

describe("registerPromptNormalization", () => {
  test("transforms main-process input when normalization changes text", async () => {
    let handler: ((event: { source: string; text: string }) => Promise<unknown>) | undefined;
    const pi = {
      on(eventName: string, nextHandler: typeof handler) {
        if (eventName === "input") handler = nextHandler;
      },
    };

    registerPromptNormalization(pi as Parameters<typeof registerPromptNormalization>[0]);

    await expect(handler?.({ source: "user", text: "  hello  \n\tworld\t" })).resolves.toEqual({
      action: "transform",
      text: "  hello\n\tworld",
    });
  });
});
