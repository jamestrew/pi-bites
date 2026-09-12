import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCodeModeHostPath } from "./code-mode/binary.js";
import { expect, test, vi } from "vitest";
import registerCodeMode from "./code-mode/registration.js";

type Handler = (event: any, ctx: any) => any;
function setup(initial = ["read", "bash", "edit", "write", "custom"]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  let active = [...initial];
  const config = { current: {} as import("../config.js").BitesConfig };
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    registerMarkdownTransformer: vi.fn(),
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
  };
  const preview = registerCodeMode(pi as never, config);
  const emit = async (name: string, event: any, ctx: any) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  return { tools, config, pi, preview, emit };
}
function context(id = "gpt-6", image = true) {
  return {
    cwd: process.cwd(),
    model: {
      id,
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: image ? ["text", "image"] : ["text"],
    },
    sessionManager: { getSessionId: () => "test-session" },
    modelRegistry: {},
    isProjectTrusted: () => true,
    signal: new AbortController().signal,
    ui: { notify: vi.fn() },
  };
}

test("registered Code Mode lifecycle preserves custom tools and restores cores on disable", async () => {
  const h = setup();
  const ctx = context();
  await h.emit("session_start", {}, ctx);
  expect(h.pi.getActiveTools()).toEqual(["exec", "wait", "custom"]);
  const options = {
    cwd: process.cwd(),
    skills: [
      {
        name: "review",
        description: "Review code",
        filePath: "/tmp/review/SKILL.md",
        baseDir: "/tmp/review",
        sourceInfo: {
          path: "test",
          source: "test",
          scope: "temporary" as const,
          origin: "top-level" as const,
        },
        disableModelInvocation: false,
      },
    ],
  };
  const chained = "project\n<pi-bites>kept</pi-bites>\n<other-extension>kept</other-extension>";
  const preview = h.preview(chained, ctx.model as never, options);
  const turn = await h.emit(
    "before_agent_start",
    { systemPrompt: chained, systemPromptOptions: options },
    ctx,
  );
  expect(turn.systemPrompt).toBe(preview);
  expect(preview.startsWith(chained)).toBe(true);
  expect(preview).toContain("text(result.output)");
  expect(preview).not.toContain("Use the read tool");
  h.config.current.disable = ["codexAdapter"];
  await h.emit("before_agent_start", { systemPrompt: "project", systemPromptOptions: {} }, ctx);
  expect(h.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "custom"]);
  await h.emit("session_shutdown", {}, ctx);
});

function hostPath() {
  if (process.env.PI_BITES_TEST_CODE_MODE_HOST) return process.env.PI_BITES_TEST_CODE_MODE_HOST;
  try {
    return getCodeModeHostPath();
  } catch {
    /* Tests can use the retained local build. */
  }
  const built = resolve(
    import.meta.dirname,
    "vendor/code-mode/target/release/codex-code-mode-host",
  );
  return existsSync(built) ? built : undefined;
}
const host = hostPath();

test.skipIf(!host)(
  "exec uses the real host, survives supported switches, and branch navigation clears state with stale contexts",
  async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const directory = mkdtempSync(join(tmpdir(), "code-mode-registration-"));
    const installed = join(directory, `pi-bites/code-mode/rust-v0.145.0/linux-${process.arch}`);
    mkdirSync(installed, { recursive: true });
    symlinkSync(host!, join(installed, "codex-code-mode-host"));
    vi.stubEnv("XDG_DATA_HOME", directory);
    const h = setup();
    const original = context();
    let stale = false;
    const ctx = Object.fromEntries(Object.entries(original).map(([key, value]) => [key, value]));
    for (const [key, value] of Object.entries(original))
      Object.defineProperty(ctx, key, {
        get() {
          if (stale) throw new Error(`stale ctx ${key}`);
          return value;
        },
      });
    const exec = async (code: string) => h.tools.get("exec").execute("outer-exec", { code });
    try {
      await h.emit("session_start", {}, ctx);
      const pending = exec(
        'store("value", 42); text(await tools.exec_command({cmd:"printf hello",login:false}));',
      );
      stale = true;
      expect((await pending).content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("hello") }),
        ]),
      );
      await h.emit("model_select", {}, context("gpt-5.6"));
      expect((await exec('text(load("value"));')).content).toContainEqual({
        type: "text",
        text: "42",
      });
      const yielded = await exec('text("first"); await yield_control(); text("second");');
      const waited = await h.tools
        .get("wait")
        .execute("outer-wait", { cell_id: yielded.details.cellId });
      expect(waited.content).toContainEqual({ type: "text", text: "second" });
      expect(waited.content).not.toContainEqual({ type: "text", text: "first" });
      await h.emit("session_tree", {}, context());
      expect((await exec('text(load("value"));')).content).toContainEqual({
        type: "text",
        text: "undefined",
      });
      expect(original.ui.notify).toHaveBeenCalledWith(
        "Code Mode cleared: branch navigation",
        "info",
      );
      const failed = await exec(
        'text("before error"); image("data:image/png;base64,aGVsbG8="); throw new Error("failure");',
      );
      expect(failed.content).toContainEqual({
        type: "image",
        mimeType: "image/png",
        data: "aGVsbG8=",
      });
      expect(
        await h.emit("tool_result", { toolName: "exec", details: failed.details }, context()),
      ).toEqual({ isError: true });
      const truncated = await exec(
        '// @exec: {"max_output_tokens":5}\ntext("0123456789012345678901234567890123456789");',
      );
      expect(truncated.content).toContainEqual({
        type: "text",
        text: "Warning: truncated output (original token count: 10)\nTotal output lines: 1\n\n0123456789…5 tokens truncated…0123456789",
      });
      await h.emit("model_select", {}, context("claude"));
      expect(h.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "custom"]);
      await expect(exec("text(1)")).rejects.toThrow(/outside supported/);
    } finally {
      await h.emit("session_shutdown", {}, {});
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("disabling exec restores displaced cores immediately at the registered lifecycle boundary", async () => {
  const h = setup();
  const ctx = context();
  await h.emit("session_start", {}, ctx);
  h.pi.setActiveTools(["wait", "custom"]);
  await h.emit("turn_start", {}, ctx);
  expect(h.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "custom", "wait"]);
  await h.emit("model_select", {}, context("gpt-5.6"));
  expect(h.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "custom", "wait"]);
  await h.emit("session_shutdown", {}, ctx);
});

test.each(["exec", "wait"])(
  "explicitly re-enabling %s survives registered lifecycle reconciliation",
  async (name) => {
    const h = setup();
    const ctx = context();
    await h.emit("session_start", {}, ctx);
    h.pi.setActiveTools(h.pi.getActiveTools().filter((tool) => tool !== name));
    await h.emit("turn_start", {}, ctx);
    expect(h.pi.getActiveTools()).not.toContain(name);
    h.pi.setActiveTools([...h.pi.getActiveTools(), name]);
    await h.emit("turn_start", {}, ctx);
    expect(h.pi.getActiveTools()).toEqual(["exec", "wait", "custom"]);
    await h.emit("session_shutdown", {}, ctx);
  },
);
