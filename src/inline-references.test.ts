import { describe, expect, test } from "bun:test";
import { parseInlineReferences } from "./inline-references.js";

describe("parseInlineReferences", () => {
  test("parses skill and prompt references", () => {
    expect(parseInlineReferences("use $skill:handoff then $prompt:review")).toEqual([
      { kind: "skill", name: "handoff", raw: "$skill:handoff" },
      { kind: "prompt", name: "review", raw: "$prompt:review" },
    ]);
  });

  test("requires token boundary and strips trailing punctuation", () => {
    expect(parseInlineReferences("cost is $5, use($skill:nope) and $skill:triage.")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
    ]);
  });

  test("dedupes by kind and name", () => {
    expect(parseInlineReferences("$skill:triage $skill:triage $prompt:triage")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
      { kind: "prompt", name: "triage", raw: "$prompt:triage" },
    ]);
  });
});
