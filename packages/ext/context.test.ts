import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { availableContextTokens, buildContextBreakdown, renderContextMarkdown } from "./context.js";

const sourceInfo = {
  path: "<builtin:read>",
  source: "builtin",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

describe("renderContextMarkdown", () => {
  it("renders the projected prompt and active tool definitions in registry order", () => {
    const tools = [
      {
        name: "read",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        sourceInfo,
      },
      {
        name: "write",
        description: "Write a file.",
        parameters: { type: "object", properties: {} },
        sourceInfo,
      },
    ] as ToolInfo[];

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
