import { expect, test, vi } from "vitest";
import registerPonytail, { previewPonytailPrompt, resolveSessionEnabled } from "./index.js";

test("restores whether Ponytail is enabled", () => {
  expect(resolveSessionEnabled([])).toBe(true);
  expect(
    resolveSessionEnabled([
      { type: "custom", customType: "ponytail-enabled", data: { enabled: true } },
      { type: "custom", customType: "ponytail-enabled", data: { enabled: false } },
    ]),
  ).toBe(false);
  expect(
    resolveSessionEnabled([
      { type: "custom", customType: "ponytail-enabled", data: { enabled: "no" } },
    ]),
  ).toBe(true);
});

test("replaces only Ponytail-owned prompt content wherever it appears", () => {
  const first = "PONYTAIL ACTIVE\n\nfirst";
  const second = "PONYTAIL ACTIVE\n\nsecond";
  const applied = previewPonytailPrompt("Base prompt", first);
  const withLaterContent = `${applied}\n\nOther extension content`;

  expect(previewPonytailPrompt(withLaterContent, first)).toBe(withLaterContent);
  expect(previewPonytailPrompt(withLaterContent, second)).toBe(
    `${previewPonytailPrompt("Base prompt", second)}\n\nOther extension content`,
  );
  expect(previewPonytailPrompt(withLaterContent)).toBe("Base prompt\n\nOther extension content");
  expect(
    previewPonytailPrompt(`${applied}${applied}`, first).match(/<pi-bites-ponytail>/g),
  ).toHaveLength(1);
});

test("registration exposes a live prompt preview across enablement", async () => {
  const handlers = new Map<string, Array<(event: never, ctx?: never) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const pi = {
    appendEntry: vi.fn(),
    on: vi.fn((name: string, handler: (event: never, ctx?: never) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, command: never) => commands.set(name, command)),
  };
  const preview = registerPonytail(pi as never);
  const ctx = {
    ui: {
      notify: vi.fn(),
    },
  };

  const activePrompt = preview("Base prompt");
  expect(activePrompt).toContain("PONYTAIL ACTIVE");

  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  const applied = (await beforeAgentStart?.({ systemPrompt: activePrompt } as never)) as {
    systemPrompt: string;
  };
  expect(applied.systemPrompt.match(/<pi-bites-ponytail>/g)).toHaveLength(1);

  const withLaterContent = `${applied.systemPrompt}\n\nOther extension content`;
  await commands.get("ponytail")?.handler("off", ctx as never);
  expect(preview(withLaterContent)).toBe("Base prompt\n\nOther extension content");
  expect(pi.appendEntry).toHaveBeenLastCalledWith("ponytail-enabled", { enabled: false });

  await commands.get("ponytail")?.handler("on", ctx as never);
  expect(preview(withLaterContent)).toContain("PONYTAIL ACTIVE");
  expect(preview(withLaterContent)).toMatch(/<\/pi-bites-ponytail>\n\nOther extension content$/);
});

test("input deactivation does not reuse a stale extension context", async () => {
  const handlers = new Map<string, Array<(event: never, ctx?: never) => unknown>>();
  const pi = {
    appendEntry: vi.fn(),
    on: vi.fn((name: string, handler: (event: never, ctx?: never) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn(),
  };
  const ui = { notify: vi.fn() };
  let stale = false;
  const ctx = {
    get sessionManager() {
      if (stale) throw new Error("stale context");
      return { getBranch: () => [] };
    },
    get ui() {
      if (stale) throw new Error("stale context");
      return ui;
    },
  };

  registerPonytail(pi as never);
  await handlers.get("session_start")?.[0]?.({} as never, ctx as never);
  stale = true;

  await expect(
    handlers.get("input")?.[0]?.({ source: "user", text: "stop ponytail" } as never),
  ).resolves.toBeUndefined();
  expect(pi.appendEntry).toHaveBeenLastCalledWith("ponytail-enabled", { enabled: false });
});
