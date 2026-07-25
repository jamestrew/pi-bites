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
  "./todo/index.js",
  "./question/index.js",
  "./notifications.js",
  "./checkpoints.js",
  "./prompt-normalization/index.js",
  "./spotme/index.js",
  "./inline-references/index.js",
  "./session-tracker/index.js",
  "./subagents/index.js",
  "./ponytail/index.js",
] as const;

type RegisterModule = (typeof registerModules)[number];

async function loadExtension(
  options: { disable?: string[]; argv?: string[]; subagent?: string } = {},
) {
  vi.resetModules();

  const registerSpies = new Map<RegisterModule, ReturnType<typeof vi.fn>>();
  for (const modulePath of registerModules) {
    const spy = vi.fn();
    registerSpies.set(modulePath, spy);
    vi.doMock(modulePath, () => ({ default: spy }));
  }

  vi.doMock("@earendil-works/pi-coding-agent", () => ({}));

  const loadConfig = vi.fn(() => (options.disable ? { disable: options.disable } : {}));
  const registerBitesCommands = vi.fn();
  vi.doMock("./config.js", () => ({
    loadConfig,
    registerBitesCommands,
  }));

  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "bun", originalArgv[1] ?? "pi", ...(options.argv ?? [])];

  const originalSubagent = process.env.PI_BITES_SUBAGENT;
  if (options.subagent) process.env.PI_BITES_SUBAGENT = options.subagent;
  else delete process.env.PI_BITES_SUBAGENT;

  const { default: registerExtension } = await import("./index.js");
  const pi = { on: vi.fn() };
  registerExtension(pi as never);

  return {
    pi,
    registerSpies,
    loadConfig,
    registerBitesCommands,
    restoreArgv: () => {
      process.argv = originalArgv;
      if (originalSubagent === undefined) delete process.env.PI_BITES_SUBAGENT;
      else process.env.PI_BITES_SUBAGENT = originalSubagent;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("extension entrypoint", () => {
  test("default registers in normal interactive sessions", async () => {
    const loaded = await loadExtension();
    try {
      expect(loaded.registerSpies.get("./footer/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./session-tracker/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./subagents/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerSpies.get("./ponytail/index.js")).toHaveBeenCalledTimes(1);
      expect(loaded.registerBitesCommands).toHaveBeenCalledTimes(1);
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

  test("can disable subagents without disabling unrelated extensions", async () => {
    const loaded = await loadExtension({ disable: ["subagents"] });
    try {
      expect(loaded.registerSpies.get("./subagents/index.js")).not.toHaveBeenCalled();
      expect(loaded.registerSpies.get("./tools.js")).toHaveBeenCalledTimes(1);
    } finally {
      loaded.restoreArgv();
    }
  });
});
