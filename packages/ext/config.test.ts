import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let agentDir = "";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => agentDir,
}));

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

describe("loadConfig", () => {
  test("ignores the retired explore toggle without disabling subagents or losing config", async () => {
    const { EXTENSION_NAMES, parseBitesConfig } = await import("./config.js");
    expect(EXTENSION_NAMES).not.toContain("explore");
    expect(EXTENSION_NAMES).toContain("subagents");
    expect(
      parseBitesConfig({
        autoCompaction: { thresholdTokens: 120_000 },
        disable: ["explore", "notifications"],
      }),
    ).toEqual({
      autoCompaction: { thresholdTokens: 120_000 },
      disable: ["notifications"],
    });
    expect(parseBitesConfig({ disable: ["explore", "subagents"] })?.disable).toEqual(["subagents"]);
    expect(parseBitesConfig({ disable: ["explore", "unknown"] })).toBeUndefined();
  });

  test("merges config from native pi-bites files", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));

    writeFileSync(
      join(agentDir, "pi-bites.json"),
      JSON.stringify({
        autoCompaction: { thresholdTokens: 150_000 },
        smallModel: { model: "github-copilot/claude-haiku-4.5", thinking: "low" },
        codexAdapter: { webSearchProviders: ["github-copilot"] },
      }),
    );
    mkdirSync(join(project, ".pi"));
    writeFileSync(
      join(project, ".pi", "pi-bites.json"),
      JSON.stringify({
        autoCompaction: { thresholdTokens: 120_000 },
        smallModel: { thinking: "minimal" },
        codexAdapter: { webSearchProviders: ["aws-bedrock"] },
      }),
      { flag: "wx" },
    );

    const { loadConfig, parseBitesConfig } = await import("./config.js");
    expect(
      parseBitesConfig({
        autoMode: { thinking: "low" },
        bashGate: { mode: "auto" },
        codexAdapter: {
          webSearchProviders: ["trusted-responses-proxy"],
          allowOpenAICodexFallback: true,
        },
        disable: ["notifications", "autoMode", "codexAdapter"],
      }),
    ).toBeDefined();
    expect(parseBitesConfig({ disable: ["not-an-extension"] })).toBeUndefined();
    expect(parseBitesConfig({ autoCompaction: { thresholdTokens: 0 } })).toBeUndefined();
    expect(parseBitesConfig({ bashGate: { mode: "automatic" } })).toBeUndefined();
    expect(
      parseBitesConfig({ codexAdapter: { webSearchProviders: ["trusted-responses-proxy"] } }),
    ).toBeDefined();
    expect(parseBitesConfig({ codexAdapter: { webSearchProviders: [""] } })).toBeUndefined();
    expect(parseBitesConfig({ codexAdapter: { allowOpenAICodexFallback: "yes" } })).toBeUndefined();

    const config = loadConfig(project);
    expect(config.autoCompaction?.thresholdTokens).toBe(120_000);
    expect(config.smallModel).toEqual({
      model: "github-copilot/claude-haiku-4.5",
      thinking: "minimal",
    });
    expect(config.codexAdapter).toEqual({ webSearchProviders: ["aws-bedrock"] });

    rmSync(project, { recursive: true, force: true });
  });

  test("reports malformed config and falls back safely", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "pi-bites.json"), JSON.stringify({ disable: [42] }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { loadConfig } = await import("./config.js");
      expect(loadConfig(project)).toEqual({
        smallModel: {},
        statusline: {},
        bashGate: {},
        notifications: {},
        autoCompaction: {},
        autoMode: {},
        codexAdapter: {},
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to parse project-local"));
    } finally {
      error.mockRestore();
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("bites commands", () => {
  describe("safe mutation", () => {
    let project: string;
    let globalPath: string;
    let projectPath: string;
    let commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
    let notify: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
      agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));
      globalPath = join(agentDir, "pi-bites.json");
      projectPath = join(project, ".pi", "pi-bites.json");
      mkdirSync(join(project, ".pi"));
      commands = new Map();
      notify = vi.fn();
      const { registerBitesCommands } = await import("./config.js");
      registerBitesCommands({
        registerCommand: (name: string, command: Parameters<typeof commands.set>[1]) =>
          commands.set(name, command),
      } as never);
    });

    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    test("refuses to overwrite malformed global config when no project config exists", async () => {
      const bytes = "{ invalid JSON containing user settings";
      writeFileSync(globalPath, bytes);

      await commands.get("bites:off")!.handler("view", { cwd: project, ui: { notify } });

      expect(readFileSync(globalPath, "utf8")).toBe(bytes);
      expect(existsSync(projectPath)).toBe(false);
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(globalPath), "error");
    });

    for (const command of ["bites:off", "bites:on"]) {
      for (const scope of ["global", "project"]) {
        test.each([
          ["malformed JSON", "{ invalid JSON containing user settings"],
          ["invalid schema", '{"smallModel":{"thinking":"invalid"},"disable":["view"]}'],
          ["non-object JSON", "[]"],
        ])(`${command} refuses ${scope} %s without writing either scope`, async (_label, bytes) => {
          const invalidPath = scope === "global" ? globalPath : projectPath;
          const otherPath = scope === "global" ? projectPath : globalPath;
          const otherBytes = command === "bites:on" ? '{"disable":["view"]}' : '{"custom":true}';
          writeFileSync(invalidPath, bytes);
          writeFileSync(otherPath, otherBytes);

          await commands.get(command)!.handler("view", { cwd: project, ui: { notify } });

          expect(readFileSync(invalidPath, "utf8")).toBe(bytes);
          expect(readFileSync(otherPath, "utf8")).toBe(otherBytes);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(invalidPath),
            "error",
          );
        });
      }
    }

    test("refuses unreadable config before enabling in either scope", async () => {
      const bytes = '{"disable":["view"]}';
      writeFileSync(globalPath, bytes);
      mkdirSync(projectPath);

      await commands.get("bites:on")!.handler("view", { cwd: project, ui: { notify } });

      expect(readFileSync(globalPath, "utf8")).toBe(bytes);
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(projectPath), "error");
    });

    test("keeps scope union and unrelated settings through no-op and two-file enable", async () => {
      const global = {
        disable: ["view", "notifications"],
        smallModel: { model: "provider/model", custom: 42 },
        custom: { keep: true },
      };
      const local = { disable: ["view"], statusline: { command: "echo status" }, extra: [1, 2] };
      const globalBytes = JSON.stringify(global);
      const projectBytes = JSON.stringify(local);
      writeFileSync(globalPath, globalBytes);
      writeFileSync(projectPath, projectBytes);

      await commands.get("bites:off")!.handler("view", { cwd: project, ui: { notify } });

      expect(notify).toHaveBeenLastCalledWith(
        '"view" is already disabled (global + project).',
        "warning",
      );
      expect(readFileSync(globalPath, "utf8")).toBe(globalBytes);
      expect(readFileSync(projectPath, "utf8")).toBe(projectBytes);

      await commands.get("bites:on")!.handler("view", { cwd: project, ui: { notify } });

      expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
        ...global,
        disable: ["notifications"],
      });
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
        statusline: { command: "echo status" },
        extra: [1, 2],
      });
      expect(notify).toHaveBeenLastCalledWith('"view" enabled.\nRestart pi to apply.', "info");
    });

    test("does not create missing files for an already enabled extension", async () => {
      await commands.get("bites:on")!.handler("view", { cwd: project, ui: { notify } });

      expect(existsSync(globalPath)).toBe(false);
      expect(existsSync(projectPath)).toBe(false);
      expect(notify).toHaveBeenCalledExactlyOnceWith('"view" is already enabled.', "warning");
    });

    test("disables in an existing project config without changing other settings or global config", async () => {
      const globalBytes = '{"disable":["notifications"],"custom":true}';
      writeFileSync(globalPath, globalBytes);
      writeFileSync(projectPath, '{"statusline":{"command":"echo status"},"custom":42}');

      await commands.get("bites:off")!.handler("view", { cwd: project, ui: { notify } });

      expect(readFileSync(globalPath, "utf8")).toBe(globalBytes);
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
        statusline: { command: "echo status" },
        custom: 42,
        disable: ["view"],
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        '"view" disabled in project config.\nRestart pi to apply.',
        "info",
      );
    });

    test.skipIf(process.getuid?.() === 0)(
      "reports write failure without reporting enable success",
      async () => {
        const bytes = '{"disable":["view"]}';
        writeFileSync(globalPath, bytes);
        writeFileSync(projectPath, bytes);
        chmodSync(projectPath, 0o400);
        try {
          await commands.get("bites:on")!.handler("view", { cwd: project, ui: { notify } });

          expect(readFileSync(projectPath, "utf8")).toBe(bytes);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(projectPath),
            "error",
          );
        } finally {
          chmodSync(projectPath, 0o600);
        }
      },
    );
  });

  test("lists one skill/prompt extension and re-enables legacy disables in both scopes", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));
    const globalPath = join(agentDir, "pi-bites.json");
    const projectPath = join(project, ".pi", "pi-bites.json");
    mkdirSync(join(project, ".pi"));
    writeFileSync(globalPath, JSON.stringify({ disable: ["inlineReferences", "notifications"] }));
    writeFileSync(projectPath, JSON.stringify({ disable: ["slashSkillAutocomplete"] }));
    const commands = new Map<
      string,
      {
        handler(args: string, ctx: unknown): Promise<void>;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
      }
    >();
    const notify = vi.fn();
    const ctx = { cwd: project, ui: { notify } };
    const { loadConfig, parseBitesConfig, registerBitesCommands } = await import("./config.js");
    registerBitesCommands({
      registerCommand: (name: string, command: Parameters<typeof commands.set>[1]) =>
        commands.set(name, command),
    } as never);

    try {
      expect(
        parseBitesConfig({
          disable: ["inlineReferences", "slashSkillAutocomplete", "skillPromptReferences"],
        })?.disable,
      ).toEqual(["skillPromptReferences"]);
      expect(parseBitesConfig({ disable: ["inlineReferences", "unknown"] })).toBeUndefined();
      expect(loadConfig(project).disable).toEqual(["skillPromptReferences", "notifications"]);
      await commands.get("bites:list")!.handler("", ctx);
      const listing = notify.mock.calls.at(-1)![0];
      expect(listing).toContain(
        "✗  skillPromptReferences  (global + project) — $skill:name / $prompt:name",
      );
      expect(listing).toContain("✓  atMentionContext — @path");
      expect(listing).not.toMatch(/inlineReferences|slashSkillAutocomplete/);
      const completions = commands.get("bites:off")!.getArgumentCompletions!("").map(
        (item) => item.value,
      );
      expect(completions).toContain("skillPromptReferences");
      expect(completions).not.toContain("inlineReferences");
      expect(completions).not.toContain("slashSkillAutocomplete");

      await commands.get("bites:on")!.handler("skillPromptReferences", ctx);
      expect(loadConfig(project).disable).toEqual(["notifications"]);
      expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ disable: ["notifications"] });
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({});
      await commands.get("bites:off")!.handler("skillPromptReferences", ctx);
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
        disable: ["skillPromptReferences"],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("list, disable, and enable codexAdapter across config reloads", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));
    const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
    const notifications: string[] = [];
    const ctx = {
      cwd: project,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    const { loadConfig, registerBitesCommands } = await import("./config.js");
    registerBitesCommands({
      registerCommand: (
        name: string,
        command: { handler(args: string, ctx: unknown): Promise<void> },
      ) => commands.set(name, command),
    } as never);

    await commands.get("bites:list")!.handler("", ctx);
    expect(notifications.at(-1)).toContain("✓  codexAdapter");

    await commands.get("bites:off")!.handler("codexAdapter", ctx);
    expect(loadConfig(project).disable).toContain("codexAdapter");
    expect(JSON.parse(readFileSync(join(agentDir, "pi-bites.json"), "utf8"))).toMatchObject({
      disable: ["codexAdapter"],
    });

    await commands.get("bites:on")!.handler("codexAdapter", ctx);
    expect(loadConfig(project).disable).toBeUndefined();
    expect(JSON.parse(readFileSync(join(agentDir, "pi-bites.json"), "utf8"))).not.toHaveProperty(
      "disable",
    );

    rmSync(project, { recursive: true, force: true });
  });
});
