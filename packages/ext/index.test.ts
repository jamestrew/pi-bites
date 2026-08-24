import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

const registerModules = [
  "./bash-gate/index.js",
  "./rtk.js",
  "./statusline.js",
  "./footer/index.js",
  "./token-count/index.js",
  "./usage-dashboard.js",
  "./context.js",
  "./tools.js",
  "./file-search/index.js",
  "./at-mention-context/index.js",
  "./notifications.js",
  "./auto-compaction.js",
  "./automode/index.js",
  "./prompt-normalization/index.js",
  "./spotme/index.js",
  "./inline-references/index.js",
  "./session-tracker/index.js",
  "./subagents/index.js",
  "./ponytail/index.js",
  "./view/index.js",
  "./goal/index.js",
  "./codex-adapter/index.js",
] as const;

type RegisterModule = (typeof registerModules)[number];

async function loadExtension(
  options: {
    disable?: string[];
    argv?: string[];
    subagent?: string;
    realGoal?: boolean;
    realCodex?: boolean;
    codexProviders?: string[];
  } = {},
) {
  vi.resetModules();

  const registerSpies = new Map<RegisterModule, ReturnType<typeof vi.fn>>();
  const previewPonytailPrompt = vi.fn((prompt: string) => `ponytail:${prompt}`);
  const autoMode = { isEnabled: vi.fn(() => false), review: vi.fn() };
  const bashGate = { isYolo: vi.fn(() => false) };
  if (options.realGoal) vi.doUnmock("./goal/index.js");
  if (options.realCodex) vi.doUnmock("./codex-adapter/index.js");
  for (const modulePath of registerModules) {
    if (modulePath === "./goal/index.js" && options.realGoal) continue;
    if (modulePath === "./codex-adapter/index.js" && options.realCodex) continue;
    const spy = vi.fn();
    if (modulePath === "./bash-gate/index.js") spy.mockReturnValue(bashGate);
    if (modulePath === "./ponytail/index.js") spy.mockReturnValue(previewPonytailPrompt);
    if (modulePath === "./automode/index.js") spy.mockReturnValue(autoMode);
    registerSpies.set(modulePath, spy);
    vi.doMock(modulePath, () => ({ default: spy }));
  }

  vi.doMock("@earendil-works/pi-coding-agent", () => ({}));

  const loadConfig = vi.fn(() => ({
    ...(options.disable ? { disable: options.disable } : {}),
    ...(options.codexProviders ? { codexAdapter: { providers: options.codexProviders } } : {}),
  }));
  const registerBitesCommands = vi.fn();
  vi.doMock("./config.js", () => ({
    loadConfig,
    registerBitesCommands,
  }));

  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "bun", originalArgv[1] ?? "pi", ...(options.argv ?? [])];

  const { default: registerExtension } = await import("./index.js");
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let activeTools = ["read", "bash", "edit", "write", "custom"];
  const pi = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => activeTools),
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
  };
  if (options.subagent) {
    const { runAsSubagent } = await import("./subagents/subagent-context.js");
    runAsSubagent(options.subagent, () => registerExtension(pi as never));
  } else {
    registerExtension(pi as never);
  }

  return {
    pi,
    registerSpies,
    previewPonytailPrompt,
    bashGate,
    handlers,
    getActiveTools: () => activeTools,
    loadConfig,
    registerBitesCommands,
    restoreArgv: () => {
      process.argv = originalArgv;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("extension entrypoint", () => {
  test("does not expose the goal prompt outside the runtime config gate", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { pi?: { prompts?: string[] } };
    expect(manifest.pi?.prompts).toBeUndefined();
  });

  test("default registers in normal interactive sessions", async () => {
    const loaded = await loadExtension();
    try {
      expect(loaded.registerSpies.get("./footer/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./session-tracker/index.js")).toHaveBeenCalledWith(
        loaded.pi,
        expect.any(Object),
        expect.objectContaining({ isEnabled: expect.any(Function) }),
      );
      expect(loaded.registerSpies.get("./subagents/index.js")).toHaveBeenCalledWith(
        loaded.pi,
        expect.any(Object),
        expect.objectContaining({ isEnabled: expect.any(Function) }),
        loaded.bashGate,
      );
      expect(loaded.registerSpies.get("./ponytail/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./goal/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./codex-adapter/index.js")).toHaveBeenCalledWith(
        loaded.pi,
        expect.any(Object),
      );
      expect(loaded.registerSpies.get("./context.js")).toHaveBeenCalledWith(
        loaded.pi,
        loaded.previewPonytailPrompt,
      );
      const preview = loaded.registerSpies.get("./context.js")?.mock.calls[0]?.[1];
      expect(preview("base")).toBe("ponytail:base");
      expect(loaded.registerBitesCommands).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("registers command authorization before command rewriting", async () => {
    const loaded = await loadExtension();
    try {
      const gateOrder =
        loaded.registerSpies.get("./bash-gate/index.js")?.mock.invocationCallOrder[0];
      const rtkOrder = loaded.registerSpies.get("./rtk.js")?.mock.invocationCallOrder[0];
      expect(gateOrder).toBeLessThan(rtkOrder!);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("subagents load shared tools and behavior without recursive features", async () => {
    const loaded = await loadExtension({ subagent: "general" });
    try {
      expect(loaded.registerSpies.get("./bash-gate/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./rtk.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./subagents/index.js")).not.toHaveBeenCalled();
    } finally {
      loaded.restoreArgv();
    }
  });

  test("can disable tracker without disabling unrelated extensions", async () => {
    const loaded = await loadExtension({ disable: ["sessionTracker"] });
    try {
      expect(loaded.registerSpies.get("./session-tracker/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./footer/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });

  test.each(["--print", "-p"])("registers subagents in %s mode", async (flag) => {
    const loaded = await loadExtension({ argv: [flag] });
    try {
      expect(loaded.registerSpies.get("./subagents/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./footer/index.js")).not.toHaveBeenCalled();
    } finally {
      loaded.restoreArgv();
    }
  });

  test("can disable subagents without disabling unrelated extensions", async () => {
    const loaded = await loadExtension({ disable: ["subagents"], argv: ["--print"] });
    try {
      expect(loaded.registerSpies.get("./subagents/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("can disable the Codex adapter without disabling unrelated extensions", async () => {
    const loaded = await loadExtension({ disable: ["codexAdapter"] });
    try {
      expect(loaded.registerSpies.get("./codex-adapter/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("assembled adapter follows provider changes without clobbering unrelated tools", async () => {
    const loaded = await loadExtension({
      realCodex: true,
      codexProviders: ["work-provider"],
    });
    try {
      expect(loaded.pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
        "apply_patch",
        "exec_command",
        "write_stdin",
      ]);

      for (const handler of loaded.handlers.get("session_start") ?? [])
        await handler({}, { cwd: process.cwd(), model: { provider: "openai-codex" } });
      expect(loaded.getActiveTools()).toEqual([
        "exec_command",
        "write_stdin",
        "apply_patch",
        "custom",
      ]);

      for (const handler of loaded.handlers.get("model_select") ?? [])
        await handler({ model: { provider: "work-provider" } }, {});
      expect(loaded.getActiveTools()).toEqual([
        "exec_command",
        "write_stdin",
        "apply_patch",
        "custom",
      ]);

      for (const handler of loaded.handlers.get("model_select") ?? [])
        await handler({ model: { provider: "out-of-scope" } }, {});
      expect(loaded.getActiveTools()).toEqual(["read", "bash", "edit", "write", "custom"]);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("assembled subagent loads adapter tools without parent-only features", async () => {
    const loaded = await loadExtension({ subagent: "general", realCodex: true });
    try {
      expect(loaded.pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
        "apply_patch",
        "exec_command",
        "write_stdin",
      ]);
      expect(loaded.registerSpies.get("./subagents/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./footer/index.js")).not.toHaveBeenCalled();
    } finally {
      loaded.restoreArgv();
    }
  });

  test("can disable goal mode without disabling unrelated extensions", async () => {
    const loaded = await loadExtension({ disable: ["goal"] });
    try {
      expect(loaded.registerSpies.get("./goal/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });

  test("complete registry exposes goal APIs only when enabled", async () => {
    const enabled = await loadExtension({ realGoal: true });
    try {
      expect(enabled.pi.registerCommand.mock.calls.map(([name]) => name)).toContain("goal");
      expect(enabled.pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
        "get_goal",
        "create_goal",
        "update_goal",
      ]);
    } finally {
      enabled.restoreArgv();
    }

    const disabled = await loadExtension({ disable: ["goal"], realGoal: true });
    try {
      expect(disabled.pi.registerCommand).not.toHaveBeenCalled();
      expect(disabled.pi.registerTool).not.toHaveBeenCalled();
    } finally {
      disabled.restoreArgv();
    }
  });
});
