import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import registerSkillPromptReferences, { parseInlineReferences } from "./index.js";

describe("parseInlineReferences", () => {
  test("parses skill and prompt references", () => {
    expect(parseInlineReferences("use $skill:handoff then $prompt:review")).toEqual([
      { kind: "skill", name: "handoff", raw: "$skill:handoff" },
      { kind: "prompt", name: "review", raw: "$prompt:review" },
    ]);
  });

  test("requires token boundary and strips trailing punctuation", () => {
    expect(parseInlineReferences("cost is $5, use($skill:nope) and $skill:triage.")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
    ]);
  });

  test("dedupes by kind and name", () => {
    expect(parseInlineReferences("$skill:triage $skill:triage $prompt:triage")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
      { kind: "prompt", name: "triage", raw: "$prompt:triage" },
    ]);
  });
});

describe("registered inline reference handler", () => {
  let cwd: string;
  let handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
  let systemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"];
  const systemPrompt =
    "Use the read tool to load a skill's file when the task matches its description.";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-inline-references-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
    const skillDir = join(cwd, "skills", "triage");
    const promptDir = join(cwd, CONFIG_DIR_NAME, "prompts");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(promptDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: triage\ndescription: Triage\n---\nInvestigate the failure.",
    );
    writeFileSync(
      join(promptDir, "review.md"),
      "---\ndescription: Review\n---\nReview the changes.",
    );

    systemPromptOptions = {
      cwd,
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: [
        Object.freeze({
          name: "triage",
          description: "Triage",
          filePath: skillPath,
          baseDir: skillDir,
          sourceInfo: Object.freeze({
            path: skillPath,
            source: "test",
            scope: "temporary" as const,
            origin: "top-level" as const,
          }),
          disableModelInvocation: false,
        }),
      ],
    };
    for (const value of Object.values(systemPromptOptions)) {
      if (typeof value === "object" && value !== null) Object.freeze(value);
    }
    Object.freeze(systemPromptOptions);

    const handlers = new Map<string, typeof handler>();
    registerSkillPromptReferences({
      on: (name: string, callback: typeof handler) => handlers.set(name, callback),
    } as unknown as ExtensionAPI);
    handler = handlers.get("before_agent_start")!;
    expect(handler).toBeTypeOf("function");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("leaves custom starts unchanged without accessing expansion context", async () => {
    const message = Object.freeze({
      role: "custom",
      customType: "continuation",
      content: "Continue with $skill:triage and $prompt:review",
      display: false,
      timestamp: 0,
    });
    const event = Object.freeze({
      type: "before_agent_start",
      messageType: "custom",
      message,
      systemPrompt,
      get systemPromptOptions() {
        throw new Error("Custom starts must not access expansion options");
      },
    });
    const ctx = {
      get cwd(): string {
        throw new Error("Custom starts must not access expansion context");
      },
    } as ExtensionContext;

    // Older hosts' types do not yet include custom startup events.
    expect(await handler(event as unknown as BeforeAgentStartEvent, ctx)).toBeUndefined();
    expect(event.message).toBe(message);
    expect(event.systemPrompt).toBe(systemPrompt);
  });

  test.each([undefined, "user"] as const)(
    "only appends hidden reference messages across referenced and ordinary inputs (message type: %s)",
    async (messageType) => {
      const originalOptions = structuredClone(systemPromptOptions);
      for (const prompt of ["$skill:triage", "address these", "$prompt:review", "ok commit"]) {
        const event = Object.freeze({
          type: "before_agent_start" as const,
          ...(messageType === undefined ? {} : { messageType }),
          prompt,
          systemPrompt,
          systemPromptOptions,
        });
        const result = await handler(event, { cwd } as ExtensionContext);

        expect(event.systemPrompt).toBe(systemPrompt);
        expect(event.systemPromptOptions).toEqual(originalOptions);
        if (!prompt.startsWith("$")) {
          expect(result).toBeUndefined();
          continue;
        }

        expect(Object.keys(result!)).toEqual(["message"]);
        expect(result?.message).toMatchObject({
          customType: "inline-reference-context",
          display: false,
          details: prompt,
        });
        const content = result?.message?.content;
        expect(content).toEqual(expect.stringMatching(/already loaded/i));
        expect(content).toEqual(expect.stringMatching(/referenced files/i));
        if (prompt === "$skill:triage") {
          expect(content).toContain(
            `<skill name="triage" location="${join(cwd, "skills", "triage", "SKILL.md")}">\nReferences are relative to ${join(cwd, "skills", "triage")}.\n\nInvestigate the failure.\n</skill>`,
          );
        } else {
          expect(content).toContain(
            `<prompt name="review" location="${join(cwd, CONFIG_DIR_NAME, "prompts", "review.md")}">\nReview the changes.\n</prompt>`,
          );
        }
      }
    },
  );

  test.each(["$skill:missing", "$prompt:missing", "$skill:missing $prompt:missing"])(
    "does not inject context or change the system prompt for unresolved references: %s",
    async (prompt) => {
      const event = Object.freeze({
        type: "before_agent_start" as const,
        prompt,
        systemPrompt,
        systemPromptOptions,
      });
      const originalEvent = structuredClone(event);
      expect(await handler(event, { cwd } as ExtensionContext)).toBeUndefined();
      expect(event).toEqual(originalEvent);
    },
  );

  test("expands each resolved reference once and skips unresolved content", async () => {
    const result = await handler(
      Object.freeze({
        type: "before_agent_start" as const,
        prompt: "$skill:triage $skill:triage. $prompt:review $prompt:review! $skill:missing",
        systemPrompt,
        systemPromptOptions,
      }),
      { cwd } as ExtensionContext,
    );

    expect(Object.keys(result!)).toEqual(["message"]);
    expect(result?.message?.details).toBe("$skill:triage, $prompt:review, $skill:missing");
    const content = result?.message?.content;
    expect(content).toEqual(expect.stringMatching(/already loaded/i));
    expect(typeof content).toBe("string");
    if (typeof content !== "string") throw new Error("Expected text reference context");
    expect(content.match(/<skill /g)).toHaveLength(1);
    expect(content.match(/<prompt /g)).toHaveLength(1);
    expect(content).toContain("Investigate the failure.");
    expect(content).toContain("Review the changes.");
    expect(content).not.toContain("missing");
  });
});
