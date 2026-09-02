import { expect, test } from "vitest";
import { buildDoneStats, formatToolCall, summarizeToolArg } from "./tool-call-format.js";

test("formats tool calls and summaries", () => {
  expect(formatToolCall("read", { path: "src/index.ts", offset: 4, limit: 3 })).toBe(
    "Read(src/index.ts:4-6)",
  );
  expect(formatToolCall("grep", { pattern: "needle" })).toBe("Grep(/needle/ in .)");
  expect(summarizeToolArg("  one\n  two  ")).toBe("one two");
});

test("formats exec_command semantically without configuration JSON", () => {
  expect(
    formatToolCall("exec_command", {
      cmd: "printf one\nthen two",
      tty: true,
      max_output_tokens: 20_000,
    }),
  ).toBe("Exec(printf one then two · TTY)");
});

test("distinguishes write_stdin input from polling without exposing characters", () => {
  expect(formatToolCall("write_stdin", { session_id: 17 })).toBe("Poll(session 17)");
  expect(formatToolCall("write_stdin", { session_id: 17, chars: "" })).toBe("Poll(session 17)");
  expect(formatToolCall("write_stdin", { session_id: 17, chars: "\u0003secret" })).toBe(
    "Input(session 17)",
  );
});

test("summarizes apply_patch operations and targets without exposing the patch", () => {
  const input = [
    "*** Begin Patch",
    "*** Add File: a.ts",
    "+export {};",
    "*** Update File: b.ts",
    "*** Move to: c.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: d.ts",
    "*** End Patch",
  ].join("\n");

  expect(formatToolCall("apply_patch", { input })).toBe(
    "ApplyPatch(3 actions · add 1, move 1, delete 1 · a.ts, b.ts → c.ts, d.ts)",
  );
  expect(formatToolCall("apply_patch", { input: "*** Begin Patch" })).toBe("ApplyPatch");
});

test("summarizes every web_run operation without serialized request arrays", () => {
  expect(
    formatToolCall("web_run", {
      search_query: [{ q: "docs\n official" }, { q: "api" }],
      image_query: [{ q: "cats" }],
      open: [{ ref_id: "turn0search1" }, { ref_id: "https://example.com" }],
      click: [{ ref_id: "turn0view0", id: 4 }],
      find: [
        { ref_id: "turn0view0", pattern: "needle" },
        { ref_id: "turn0view0", pattern: "thread" },
      ],
      response_length: "short",
    }),
  ).toBe(
    "Web(Search docs official (+1) · Images cats · Open 2 results · Click link 4 · Find needle (+1))",
  );
  expect(formatToolCall("web_run", { search_query: [{}] })).toBe("Web(Search)");
});

test("formats view_image as a sanitized path", () => {
  expect(
    formatToolCall("view_image", { path: "images/cat.png\u001b]2;changed title\u0007\nignored" }),
  ).toBe("View(images/cat.png ignored)");
  expect(formatToolCall("view_image", {})).toBe("View");
});

test("keeps partial Codex adapter calls semantic", () => {
  expect(formatToolCall("exec_command", {})).toBe("Exec");
  expect(formatToolCall("write_stdin", { chars: "x" })).toBe("Input(session ?)");
  expect(formatToolCall("apply_patch", {})).toBe("ApplyPatch");
  expect(formatToolCall("web_run", {})).toBe("Web");
  expect(formatToolCall("view_image", {})).toBe("View");
});

test("keeps non-Codex tool formatting compatible", () => {
  expect(formatToolCall("bash", { command: "git status" })).toBe("Bash(git status)");
  expect(formatToolCall("custom", { value: 1 })).toBe('Custom({"value":1})');
});

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
    }),
  ).toBe("1 tool use · ↑42 ↓7 W5");
});
