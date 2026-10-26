import {
  formatSkillsForPrompt,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  type BuildSystemPromptOptions,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerContext, {
  availableContextTokens,
  buildContextBreakdown,
  renderContextMarkdown,
} from "./context.js";
import { setup } from "./codex-adapter/test/native-session.js";

const sourceInfo = {
  path: "<builtin:read>",
  source: "builtin",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

describe("renderContextMarkdown", () => {
  it("renders the projected prompt and active tool definitions in registry order", () => {
    const tools: ToolInfo[] = [
      {
        name: "read",
        description: "Read a file.",
        exposure: "direct",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        sourceInfo,
      },
      {
        name: "write",
        description: "Write a file.",
        exposure: "direct",
        parameters: { type: "object", properties: {} },
        sourceInfo,
      },
    ];

    expect(
      renderContextMarkdown({
        timestamp: "2026-03-18T12:00:00.000Z",
        model: "provider/model-id",
        systemPrompt: "Projected system prompt.",
        tools,
        activeTools: ["write"],
      }),
    ).toBe(`<meta>

- **timestamp**: 2026-03-18T12:00:00.000Z
- **model**: provider/model-id

</meta>

<system-prompt>

Projected system prompt.

</system-prompt>

<tools>

### write

Write a file.

\`\`\`json
{
  "type": "object",
  "properties": {}
}
\`\`\`

</tools>
`);
  });
});

describe("buildContextBreakdown", () => {
  it("separates context files and skills from a matching Pi system prompt", () => {
    const options: BuildSystemPromptOptions = {
      customPrompt: "You are a concise coding assistant.",
      appendSystemPrompt: "Prefer minimal changes.",
      cwd: "/tmp/project",
      selectedTools: ["read"],
      contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Run bun check." }],
      skills: [
        {
          name: "review",
          description: "Review code",
          filePath: "/tmp/review/SKILL.md",
          baseDir: "/tmp/review",
          sourceInfo,
          disableModelInvocation: false,
        },
        {
          name: "manual-only",
          description: "Only available through its command",
          filePath: "/tmp/manual-only/SKILL.md",
          baseDir: "/tmp/manual-only",
          sourceInfo,
          disableModelInvocation: true,
        },
      ],
    };
    const systemPrompt = `${options.customPrompt}\n\n${options.appendSystemPrompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/project/AGENTS.md">\nRun bun check.\n</project_instructions>\n\n</project_context>\n${formatSkillsForPrompt(options.skills ?? [])}\nCurrent working directory: /tmp/project`;

    const result = buildContextBreakdown({
      total: 246,
      window: 10_000,
      systemPrompt,
      options,
      tools: [],
      activeTools: [],
      messageTokens: 50,
    });

    expect(result.total).toBe(246);
    expect(result.parts).toEqual([
      { label: "System prompt", tokens: 47 },
      { label: "System tools", tokens: 0, details: [] },
      {
        label: "Context files",
        tokens: 23,
        details: [{ label: "/tmp/project/AGENTS.md", tokens: 23 }],
      },
      { label: "Skills", tokens: 126, details: [{ label: "review", tokens: 126 }] },
      { label: "Messages", tokens: 50 },
    ]);
  });

  it("uses static context estimates before the first provider response", () => {
    const result = buildContextBreakdown({
      total: 0,
      window: 1_000,
      systemPrompt: "12345678",
      options: { cwd: "/tmp" },
      tools: [],
      activeTools: [],
      messageTokens: 3,
    });

    expect(result.total).toBe(5);
    expect(result.parts.find((part) => part.label === "Messages")?.tokens).toBe(3);
  });

  it("includes skills loadable through exec_command", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/tmp",
      selectedTools: ["exec_command"],
      skills: [
        {
          name: "review",
          description: "Review code",
          filePath: "/tmp/review/SKILL.md",
          baseDir: "/tmp/review",
          sourceInfo,
          disableModelInvocation: false,
        },
      ],
    };
    const result = buildContextBreakdown({
      total: 100,
      window: 1_000,
      systemPrompt: formatSkillsForPrompt(options.skills ?? []).replace(
        "Use the read tool",
        "Use exec",
      ),
      options,
      tools: [],
      activeTools: [],
      messageTokens: 0,
    });

    expect(result.parts.find((part) => part.label === "Skills")?.details).toEqual([
      { label: "review", tokens: 126 },
    ]);
  });

  it("does not rescale category estimates to fit a provider total", () => {
    const result = buildContextBreakdown({
      total: 4,
      window: 1_000,
      systemPrompt: "12345678901234567890",
      options: { cwd: "/tmp" },
      tools: [],
      activeTools: [],
      messageTokens: 3,
    });

    expect(result.total).toBe(4);
    expect(result.parts.find((part) => part.label === "System prompt")?.tokens).toBe(5);
    expect(result.parts.find((part) => part.label === "Messages")?.tokens).toBe(3);
    expect(result.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(8);
    expect(availableContextTokens(result)).toBe(996);
  });
});

it("inspector estimates projected messages without changing raw history", async () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({
    role: "system",
    content: "12345678",
    toolsAdded: [
      { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } },
    ],
    timestamp: 0,
  });
  const omitted = manager.appendMessage({
    role: "user",
    content: "omitted ".repeat(100),
    timestamp: 1,
  });
  const replaced = manager.appendMessage({
    role: "user",
    content: "replaced ".repeat(100),
    timestamp: 2,
  });
  manager.appendContextEdit(omitted, null);
  manager.appendContextEdit(replaced, { content: "12345678" });
  let handler!: RegisteredCommand["handler"];
  registerContext({
    registerCommand(_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      handler = command.handler;
    },
    getAllTools: () => [
      {
        name: "read",
        description: "Read a file.",
        exposure: "direct",
        parameters: { type: "object", properties: {} },
        sourceInfo,
      },
    ],
    getActiveTools: () => ["read"],
  } as unknown as ExtensionAPI);
  let lines: string[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  await handler("", {
    mode: "tui",
    model: { id: "test", contextWindow: 10000 },
    sessionManager: manager,
    getSystemPrompt: () => "12345678",
    getSystemPromptOptions: () => ({ cwd: "/tmp" }),
    getContextUsage: () => undefined,
    ui: {
      custom: async (
        factory: (
          _tui: unknown,
          theme: unknown,
          _kb: unknown,
          done: () => void,
        ) => { render(width: number): string[] },
      ) => {
        lines = factory(undefined, theme, undefined, () => {}).render(120);
      },
    },
  } as unknown as ExtensionCommandContext);
  expect(lines.join("\n")).toContain("Messages: ~2 tokens");
  expect(lines.join("\n")).toContain("System tools: ~24 tokens");
  expect(lines.join("\n")).toContain("28/10k tokens");
  expect(manager.getEntry(omitted)).toMatchObject({ message: { content: "omitted ".repeat(100) } });
  expect(manager.getEntry(replaced)).toMatchObject({
    message: { content: "replaced ".repeat(100) },
  });
});

it.each(["gpt-6.1-sol", "claude"])(
  "context all lists nested tools without double-counting on %s",
  async (model) => {
    const h = await setup(undefined, {
      model,
      config: { codexAdapter: { webSearchProviders: ["native-test"] } },
    });
    let handler!: RegisteredCommand["handler"];
    registerContext(
      {
        registerCommand(_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
          handler = command.handler;
        },
        getAllTools: () => h.session.getAllTools(),
        getActiveTools: () => h.session.getActiveToolNames(),
      } as unknown as ExtensionAPI,
      undefined,
      () => h.previewTools(),
    );
    let lines: string[] = [];
    const inspect = async () => {
      await handler("all", {
        ...h.getContext(),
        mode: "tui",
        getSystemPromptOptions: () => ({ cwd: h.cwd }),
        ui: {
          custom: async (
            factory: (
              _tui: unknown,
              theme: unknown,
              _kb: unknown,
              done: () => void,
            ) => { render(width: number): string[] },
          ) => {
            const theme = {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            };
            lines = factory(undefined, theme, undefined, () => {}).render(160);
          },
        },
      } as unknown as ExtensionCommandContext);
      return lines.join("\n");
    };

    expect(h.session.getActiveToolNames()).not.toContain("exec_command");
    const expanded = await inspect();
    if (model === "claude") {
      for (const name of ["read", "bash", "edit", "write"])
        expect(expanded).toMatch(new RegExp(`${name}: ~[\\d.]+k? tokens`));
      expect(expanded).toContain("System tools · 1 items");
      expect(expanded).not.toContain("exec_command");
      expect(expanded).not.toContain("apply_patch");
    } else {
      expect(expanded).toContain("exec_command");
      expect(expanded).toContain("apply_patch");
      expect(expanded).toMatch(/exec_command: ~[\d.]+k? tokens/);
      expect(expanded).toMatch(
        /ALL_TOOLS, searchTools, describeTool, describeNamespace: ~\d+ tokens \(builtin, shared\)/,
      );
      expect(expanded).toMatch(/web_run: ~[\d.]+k? tokens\n/);
    }

    h.setTools([]);
    await h.session.extensionRunner.emit({ type: "model_select" } as never);
    h.setTools(["read", "codemode"]);
    await h.session.extensionRunner.emit({ type: "model_select" } as never);
    const readonly = await inspect();
    expect(readonly).not.toContain("exec_command");
    expect(readonly).not.toContain("apply_patch");
    if (model === "claude") expect(readonly).toMatch(/read: ~[1-9][\d.]*k? tokens/);
    else expect(readonly).toContain("read: ~0 tokens (declared separately)");
  },
);

it("attributes only prepared sections and distinguishes explicit and budget deferral", () => {
  const makeTool = (name: string, exposure: ToolInfo["exposure"]): ToolInfo => ({
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    exposure,
    sourceInfo,
  });
  const inlineSection = [
    "### `raw_inline` (`raw-inline`)",
    "Inline help.",
    "### Internal heading",
    "````markdown",
    "```",
    "### `explicit`",
    "## demo",
    "````",
    "~~~markdown",
    "### `budget`",
    "~~~",
    "More help.",
    "",
    "",
  ].join("\n");
  const namespacedSection = "### `namespaced`\nNamespaced help.";
  const codemode = {
    ...makeTool("codemode", "model-only"),
    description: `Run code.\n\nGlobals:\n- \`ALL_TOOLS\`, \`await searchTools(query)\`, \`await describeTool(name)\`, \`await describeNamespace(name)\`: discover tools.\n\nNested tools:\n\n${inlineSection}## demo (some tools not listed)\nShared namespace help.\n\n${namespacedSection}`,
  };
  const result = buildContextBreakdown({
    total: null,
    window: 10000,
    systemPrompt: "",
    options: { cwd: "/tmp" },
    tools: [
      codemode,
      makeTool("raw-inline", "codemode"),
      { ...makeTool("namespaced", "codemode"), namespace: { name: "demo", description: "Demo" } },
      makeTool("explicit", "deferred"),
      makeTool("budget", "codemode"),
      makeTool("read", "direct"),
      makeTool("inactive", "direct"),
      makeTool("hidden", "hidden"),
      makeTool("modelOnly", "model-only"),
    ],
    activeTools: ["read", "codemode"],
    messageTokens: 0,
  });
  const parent = result.parts.find((part) => part.label === "System tools")!.details![0]!;
  const escapedTokens = (text: string) => Math.ceil(JSON.stringify(text).slice(1, -1).length / 4);
  expect(parent.nestedTools).toEqual([
    { label: "raw-inline", tokens: escapedTokens(inlineSection) },
    { label: "namespaced", tokens: escapedTokens(namespacedSection) },
    { label: "explicit", tokens: 0, note: "deferred" },
    { label: "budget", tokens: 0, note: "deferred" },
    { label: "read", tokens: 0, note: "declared separately" },
    {
      label: "ALL_TOOLS, searchTools, describeTool, describeNamespace",
      tokens: expect.any(Number),
      note: "builtin, shared",
    },
    { label: "runtime & wrapper", tokens: expect.any(Number) },
  ]);
  expect(parent.nestedTools!.reduce((sum, item) => sum + item.tokens, 0)).toBe(parent.tokens);
});
