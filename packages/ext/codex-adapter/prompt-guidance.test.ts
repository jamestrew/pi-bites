import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

vi.mock("./apply-patch/tool.js", () => ({ registerApplyPatchTool: vi.fn() }));
vi.mock("./exec/session-manager.js", () => ({
  createExecSessionManager: () => ({ shutdown: vi.fn() }),
}));
vi.mock("./exec/command-tool.js", () => ({ registerExecCommandTool: vi.fn() }));
vi.mock("./exec/write-stdin-tool.js", () => ({ registerWriteStdinTool: vi.fn() }));

import registerCodexAdapter from "./index.js";

type Handler = (event: any, ctx: any) => unknown;

function setup(providers: string[] = []) {
  const handlers = new Map<string, Handler>();
  let activeTools = ["exec_command", "write_stdin", "apply_patch"];
  const preview = registerCodexAdapter(
    {
      registerTool: vi.fn(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      getActiveTools: () => activeTools,
      setActiveTools: (tools: string[]) => {
        activeTools = tools;
      },
    } as never,
    { current: { codexAdapter: { providers } } },
  );
  const handler = handlers.get("before_agent_start")!;
  const run = (systemPrompt: string, model: object, selectedTools?: string[], skills?: Skill[]) =>
    handler(
      {
        systemPrompt,
        systemPromptOptions: { selectedTools, skills },
      },
      { model },
    ) as { systemPrompt: string } | undefined;
  return { preview, run };
}

const codex = { provider: "openai-codex", id: "gpt-5.3-codex" };
const sourceInfo = {
  path: "<test>",
  source: "test",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

describe("Codex adapter prompt guidance", () => {
  test("preserves the incoming prompt and describes only active retained tools", () => {
    const { run } = setup();
    const surrounding = "Project instructions\r\n\0skills\n\nOther extension";
    const result = run(surrounding, codex, ["custom", "apply_patch", "exec_command"])!;

    expect(result.systemPrompt.slice(0, surrounding.length)).toBe(surrounding);
    expect(result.systemPrompt.match(/<pi-bites-tool-guidance>/g)).toHaveLength(1);
    expect(result.systemPrompt).toContain("`exec_command`");
    expect(result.systemPrompt).toContain("yield");
    expect(result.systemPrompt).toContain("`session_id`");
    expect(result.systemPrompt).toContain("`apply_patch`");
    expect(result.systemPrompt).toContain("`*** Begin Patch`");
    expect(result.systemPrompt).not.toContain("`write_stdin`");
    expect(result.systemPrompt).not.toContain("custom");
  });

  test("documents polling, input, interruption, and continuation for write_stdin", () => {
    const result = setup().run("base", codex, ["write_stdin"])!.systemPrompt;
    expect(result).toContain("omit `chars` to poll and continue waiting");
    expect(result).toContain("interactive input");
    expect(result).toContain("`\\u0003`");
    expect(result).toContain("until the session completes");
    expect(result).not.toContain("`exec_command`");
    expect(result).not.toContain("`apply_patch`");
  });

  test("keeps model-invoked skills available after replacing read with exec_command", () => {
    const skills = [
      {
        name: "review",
        description: "Review code",
        filePath: "/tmp/review/SKILL.md",
        baseDir: "/tmp/review",
        sourceInfo,
        disableModelInvocation: false,
      },
      {
        name: "manual",
        description: "Manual only",
        filePath: "/tmp/manual/SKILL.md",
        baseDir: "/tmp/manual",
        sourceInfo,
        disableModelInvocation: true,
      },
    ];
    const result = setup().run("base", codex, ["exec_command"], skills)!.systemPrompt;

    expect(result).toContain("<name>review</name>");
    expect(result).toContain("Use `exec_command` to load a skill's file");
    expect(result).not.toContain("<name>manual</name>");
    expect(
      setup().run("base", codex, ["read", "exec_command"], skills)!.systemPrompt,
    ).not.toContain("<available_skills>");
  });

  test("previews skill additions for context alongside an existing ponytail prompt", () => {
    const skills: Skill[] = [
      {
        name: "review",
        description: "Review code",
        filePath: "/tmp/review/SKILL.md",
        baseDir: "/tmp/review",
        sourceInfo,
        disableModelInvocation: false,
      },
    ];
    const prompt = setup().preview("base\n<pi-bites-ponytail>full</pi-bites-ponytail>", codex, {
      cwd: "/tmp",
      selectedTools: ["exec_command"],
      skills,
    });

    expect(prompt).toContain("<pi-bites-ponytail>full</pi-bites-ponytail>");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>review</name>");
  });

  test("recomputes guidance across model, provider scope, and tool changes", () => {
    const { run } = setup(["bedrock"]);
    expect(run("base", codex, ["exec_command"])?.systemPrompt).toContain("`exec_command`");
    expect(run("base", { provider: "other", id: "plain" }, ["exec_command"])).toBeUndefined();
    expect(
      run("base", { provider: "bedrock", id: "plain" }, ["apply_patch"])?.systemPrompt,
    ).toContain("`apply_patch`");
    expect(run("base", codex, ["custom"])).toBeUndefined();
  });

  test("composes in either additive handler order", () => {
    const { run } = setup();
    const other = (prompt: string) => `${prompt}\n\n<other>byte-for-byte</other>`;
    const adapterFirst = other(run("base", codex, ["exec_command"])!.systemPrompt);
    const otherFirst = run(other("base"), codex, ["exec_command"])!.systemPrompt;

    expect(adapterFirst).toContain("</pi-bites-tool-guidance>\n\n<other>byte-for-byte</other>");
    expect(otherFirst).toContain("<other>byte-for-byte</other>\n\n<pi-bites-tool-guidance>");
  });

  test("uses provider-neutral wording for configured Copilot and Bedrock runtimes", () => {
    const { run } = setup(["github-copilot", "bedrock"]);
    for (const provider of ["github-copilot", "bedrock"]) {
      const result = run("base", { provider, id: "gpt-5" }, ["exec_command"])!.systemPrompt;
      expect(result.toLowerCase()).not.toContain("openai");
      expect(result.toLowerCase()).not.toContain("transport");
    }
  });

  test("automatically adapts GPT models served by Copilot", () => {
    const result = setup().run("base", { provider: "github-copilot", id: "gpt-5.4" }, [
      "exec_command",
    ])!.systemPrompt;
    expect(result).toContain("`exec_command`");
  });
});
