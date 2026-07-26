import { expect, test, vi } from "vitest";
import registerPonytail, {
  parsePonytailModeEntry,
  previewPonytailPrompt,
  resolveSessionMode,
} from "./index.js";

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

test("replaces only Ponytail-owned prompt content wherever it appears", () => {
  const full = "PONYTAIL MODE ACTIVE — level: full";
  const lite = "PONYTAIL MODE ACTIVE — level: lite";
  const applied = previewPonytailPrompt("Base prompt", full);
  const withLaterContent = `${applied}\n\nOther extension content`;

  expect(previewPonytailPrompt(withLaterContent, full)).toBe(withLaterContent);
  expect(previewPonytailPrompt(withLaterContent, lite)).toBe(
    `${previewPonytailPrompt("Base prompt", lite)}\n\nOther extension content`,
  );
  expect(previewPonytailPrompt(withLaterContent)).toBe("Base prompt\n\nOther extension content");
  expect(
    previewPonytailPrompt(`${applied}${applied}`, full).match(/<pi-bites-ponytail>/g),
  ).toHaveLength(1);
});

test("registration exposes a live prompt preview across prompt and mode lifecycle", async () => {
  const handlers = new Map<string, Array<(event: never, ctx?: never) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const pi = {
    appendEntry: vi.fn(),
    on: vi.fn((name: string, handler: (event: never, ctx?: never) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, command: never) => commands.set(name, command)),
    sendUserMessage: vi.fn(),
  };
  const preview = registerPonytail(pi as never);
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  const beforeFirstPrompt = preview("Base prompt");
  expect(beforeFirstPrompt).toContain("PONYTAIL MODE ACTIVE — level: full");

  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  const applied = (await beforeAgentStart?.({ systemPrompt: beforeFirstPrompt } as never)) as {
    systemPrompt: string;
  };
  expect(applied.systemPrompt.match(/<pi-bites-ponytail>/g)).toHaveLength(1);

  const withLaterContent = `${applied.systemPrompt}\n\nOther extension content`;
  await commands.get("ponytail")?.handler("lite", ctx as never);
  expect(preview(withLaterContent)).toContain("PONYTAIL MODE ACTIVE — level: lite");
  expect(preview(withLaterContent)).toMatch(/<\/pi-bites-ponytail>\n\nOther extension content$/);

  await commands.get("ponytail")?.handler("off", ctx as never);
  expect(preview(withLaterContent)).toBe("Base prompt\n\nOther extension content");
  expect(
    (await beforeAgentStart?.({ systemPrompt: withLaterContent } as never)) as {
      systemPrompt: string;
    },
  ).toEqual({ systemPrompt: "Base prompt\n\nOther extension content" });
});
