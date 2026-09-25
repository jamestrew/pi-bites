import { describe, expect, test } from "vitest";
import { parseAutoModeDecision } from "./index.js";

describe("Guardian parser compatibility", () => {
  test("parses strict outcomes and rejects invalid responses", () => {
    expect(parseAutoModeDecision('{"outcome":"allow"}')).toEqual({
      outcome: "allow",
      risk_level: "low",
      user_authorization: "unknown",
      rationale: "Auto-review returned a low-risk allow decision.",
    });
    expect(parseAutoModeDecision('{"outcome":"deny","rationale":"too broad"}')).toEqual({
      outcome: "deny",
      risk_level: "high",
      user_authorization: "unknown",
      rationale: "too broad",
    });
    expect(() => parseAutoModeDecision('{"outcome":"maybe"}')).toThrow("invalid outcome");
  });
  test.each([
    {},
    { risk_level: null, user_authorization: null, rationale: null },
    { rationale: "  \n " },
  ])("defaults missing/null/empty details: %j", (details) => {
    expect(parseAutoModeDecision(JSON.stringify({ outcome: "deny", ...details }))).toEqual({
      outcome: "deny",
      risk_level: "high",
      user_authorization: "unknown",
      rationale: "Auto-review returned a deny decision without a rationale.",
    });
  });
  test("accepts prose wrappers and ignores unknown keys like upstream", () => {
    expect(
      parseAutoModeDecision(
        'preface {"outcome":"allow","risk_level":"medium","user_authorization":"low","rationale":"bounded","extra":true} suffix',
      ),
    ).toEqual({
      outcome: "allow",
      risk_level: "medium",
      user_authorization: "low",
      rationale: "bounded",
    });
  });
  test.each([
    "{}",
    '{"outcome":null}',
    '{"outcome":true}',
    '{"outcome":"allow","risk_level":42}',
    '{"outcome":"allow"} {"outcome":"deny"}',
  ])("rejects malformed assessment: %s", (payload) => {
    expect(() => parseAutoModeDecision(payload)).toThrow();
  });
});
