import { expect, test } from "vitest";
import { parsePonytailModeEntry, resolveSessionMode } from "./index.js";

test("parses persisted Ponytail modes and rejects malformed entries", () => {
  const entry = { mode: "full", futureField: true };
  expect(parsePonytailModeEntry(entry)).toBe(entry);
  expect(parsePonytailModeEntry({ mode: 42 })).toBeUndefined();
  expect(parsePonytailModeEntry({ mode: "FULL" })).toBeUndefined();
  expect(parsePonytailModeEntry({ mode: " full " })).toBeUndefined();
  expect(
    resolveSessionMode([{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }]),
  ).toBe("ultra");
  expect(
    resolveSessionMode([
      { type: "custom", customType: "ponytail-mode", data: { mode: "invalid" } },
    ]),
  ).toBe("full");
});
