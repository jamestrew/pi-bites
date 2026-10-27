import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  initTheme,
  parseSkillBlock,
  UserMessageComponent,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import registerInlineReferences from "./index.js";
import registerBites from "../index.js";
import registerAutoMode from "../automode/index.js";
import { EXTENSION_NAMES } from "../config.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"] = [{ type: "text", text: "Done." }],
  stopReason: "stop" | "toolUse" = "stop",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

async function fixture(
  tools: ToolDefinition[] = [],
  options: { assembled?: boolean; reviewer?: boolean } = {},
) {
  const { assembled = false } = options;
  const cwd = mkdtempSync(join(tmpdir(), "inline-references-e2e-"));
  cleanup.push(async () => rmSync(cwd, { recursive: true, force: true }));
  const skillDir = join(cwd, "skills", "triage");
  const promptDir = join(cwd, CONFIG_DIR_NAME, "prompts");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, "---\nname: triage\ndescription: Triage\n---\nSKILL_BODY_FIXTURE");
  writeFileSync(join(promptDir, "review.md"), "PROMPT_BODY_FIXTURE");
  writeFileSync(join(promptDir, "forward.md"), "Review $ARGUMENTS");
  writeFileSync(join(promptDir, "drop.md"), "No arguments.");
  writeFileSync(
    join(promptDir, "chain.md"),
    "Inspect @context.txt with $skill:triage and $prompt:review",
  );
  writeFileSync(join(cwd, "context.txt"), "FILE_BODY_FIXTURE");
  if (assembled) {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
    writeFileSync(
      join(cwd, CONFIG_DIR_NAME, "pi-bites.json"),
      JSON.stringify({
        disable: EXTENSION_NAMES.filter(
          (name) =>
            ![
              "skillPromptReferences",
              "atMentionContext",
              "codexAdapter",
              "promptNormalization",
            ].includes(name),
        ),
      }),
    );
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    noExtensions: true,
    extensionFactories: [
      async (pi) => {
        if (!assembled) {
          registerInlineReferences(pi);
          if (options.reviewer) {
            const reviewer = registerAutoMode(pi, { current: {} });
            pi.registerTool(
              defineTool({
                name: "review_probe",
                label: "Review probe",
                description: "Review without executing a shell command.",
                parameters: Type.Object({}),
                async execute(_id, _params, _signal, _update, ctx) {
                  const decision = await reviewer.review(
                    { execution: { cwd }, command: "echo test" },
                    ctx,
                  );
                  return {
                    content: [{ type: "text", text: JSON.stringify(decision) }],
                    details: {},
                  };
                },
              }),
            );
          }
          return;
        }
        const currentDirectory = vi.spyOn(process, "cwd").mockReturnValue(cwd);
        try {
          await registerBites(pi);
        } finally {
          currentDirectory.mockRestore();
        }
        // A failed rendering concern must not disable the others.
        pi.registerMarkdownTransformer(() => {
          throw new Error("Unrelated renderer failure");
        });
        pi.registerMarkdownTransformer((text, ctx) =>
          ctx.messageType === "assistant"
            ? text.replace("CITATION_FIXTURE", "CITATION_RENDERED")
            : text,
        );
      },
    ],
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: () => ({
      skills: [
        {
          name: "triage",
          description: "Triage",
          filePath: skillPath,
          baseDir: skillDir,
          sourceInfo: {
            path: skillPath,
            baseDir: cwd,
            source: "test",
            scope: "temporary",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    }),
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const reviews: Context["messages"][] = [];
  runtime.registerProvider("inline-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    streamSimple: (model, context) => {
      reviews.push(structuredClone(context.messages));
      return response(model, [{ type: "text", text: '{"outcome":"allow"}' }]);
    },
    models: [
      {
        id: "model",
        name: "Inline test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 100,
      },
    ],
  });
  const model = runtime.getModel("inline-test", "model")!;
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    tools: [...tools.map((tool) => tool.name), ...(options.reviewer ? ["review_probe"] : [])],
    customTools: tools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  cleanup.push(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const requests: Context["messages"][] = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(structuredClone(context.messages));
    return response(model);
  };
  return { cwd, session, requests, reviews, errors };
}

function userText(messages: AgentSession["messages"] | Context["messages"], index = -1): string {
  const message = messages.filter((message) => message.role === "user").at(index);
  if (!message || message.role !== "user") throw new Error("Missing user message");
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function renderUser(session: AgentSession): string {
  initTheme("dark", false);
  return new UserMessageComponent(
    userText(session.messages),
    undefined,
    0,
    session.extensionRunner.getMarkdownTransformers(),
  )
    .render(160)
    .join("\n");
}

function persistedUserText(session: AgentSession): string {
  return userText(
    session.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
  );
}

const prompt = "Inspect @context.txt with $skill:triage and $prompt:review";

function expectAttached(text: string, original = prompt) {
  expect(text.startsWith(original)).toBe(true);
  for (const body of ["FILE_BODY_FIXTURE", "SKILL_BODY_FIXTURE", "PROMPT_BODY_FIXTURE"]) {
    expect(text.indexOf(body)).toBeGreaterThan(original.length);
    expect(text.split(body)).toHaveLength(2);
  }
}

test("attaches file, skill, and prompt context after the original text in the same user message", async () => {
  const { session, requests, errors } = await fixture();
  await session.prompt(prompt);

  expect(errors).toEqual([]);
  expectAttached(userText(session.messages));
  expectAttached(persistedUserText(session));
  expectAttached(userText(requests[0]!));
  expect(session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
});

test("renders only the original user text while retaining attached context", async () => {
  const { session } = await fixture();
  await session.prompt(prompt);
  const text = userText(session.messages);
  const rendered = renderUser(session);

  expectAttached(text);
  expect(rendered).toContain(prompt);
  expect(rendered).not.toContain("FILE_BODY_FIXTURE");
  expect(rendered).not.toContain("SKILL_BODY_FIXTURE");
  expect(rendered).not.toContain("PROMPT_BODY_FIXTURE");
  expect(rendered).not.toContain("pi-bites-inline-context");
});

test.each(["steer", "followUp"] as const)(
  "keeps referenced context attached to its %s input without splitting tool calls and results",
  async (streamingBehavior) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "pause_for_input",
      label: "Pause",
      description: "Hold a tool batch for queued input.",
      parameters: Type.Object({}),
      async execute() {
        entered();
        await paused;
        return { content: [{ type: "text", text: "Tool finished." }], details: {} };
      },
    });
    const { session, requests, errors } = await fixture([tool]);
    session.agent.streamFunction = (model, context) => {
      requests.push(structuredClone(context.messages));
      return requests.length === 1
        ? response(
            model,
            [{ type: "toolCall", id: "pause", name: tool.name, arguments: {} }],
            "toolUse",
          )
        : response(model);
    };
    const running = session.prompt("Start the tool.");
    try {
      await started;
      await session.prompt(prompt, { streamingBehavior });
      release();
      await running;

      expect(errors).toEqual([]);
      expectAttached(userText(session.messages));
      expectAttached(persistedUserText(session));
      expectAttached(userText(requests.at(-1)!));
      expect(renderUser(session)).toContain(prompt);
      expect(renderUser(session)).not.toContain("FILE_BODY_FIXTURE");
      for (const messages of requests.slice(0, -1)) {
        expect(JSON.stringify(messages)).not.toContain("FILE_BODY_FIXTURE");
      }
      expect(session.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "toolResult",
        ...(streamingBehavior === "followUp" ? ["assistant"] : []),
        "user",
        "assistant",
      ]);
    } finally {
      release();
      await session.abort();
      await running;
    }
  },
);

test("assembled extension preserves user hiding alongside other Markdown transformers", async () => {
  const { session, errors } = await fixture([], { assembled: true });
  await session.prompt(prompt);
  expect(errors).toEqual([]);
  const transformers = session.extensionRunner.getMarkdownTransformers();
  const rendered = renderUser(session);
  expect(rendered).toContain(prompt);
  expect(rendered).not.toContain("FILE_BODY_FIXTURE");
  expect(
    transformers.reduce(
      (text, transform) =>
        transform(text, {
          messageType: "assistant",
          isStreaming: false,
          availableWidth: 120,
        }),
      "CITATION_FIXTURE citeturn9view9",
    ),
  ).toBe("CITATION_RENDERED [web source]");
});

test.each(["", "\nAlso explain the result."])(
  "resubmitting stored input replaces its old hidden context (edit=%j)",
  async (edit) => {
    const { session } = await fixture();
    await session.prompt(prompt);
    const stored = userText(session.messages);
    await session.prompt(stored + edit);

    const text = userText(session.messages);
    expect(text.split("<pi-bites-inline-context")).toHaveLength(2);
    expect(text.split("SKILL_BODY_FIXTURE")).toHaveLength(2);
    const rendered = renderUser(session);
    expect(rendered).toContain(prompt);
    expect(rendered).not.toContain("SKILL_BODY_FIXTURE");
    if (edit) expect(rendered).toContain(edit.trim());
  },
);

test("only reattaches files when their content changes, and keeps line ranges independent", async () => {
  const { session, cwd } = await fixture();
  await session.prompt("Inspect @context.txt");
  expect(userText(session.messages)).toContain("FILE_BODY_FIXTURE");
  utimesSync(join(cwd, "context.txt"), new Date(), new Date());
  await session.prompt("Inspect @context.txt again");
  expect(userText(session.messages)).toBe("Inspect @context.txt again");

  writeFileSync(join(cwd, "context.txt"), "first\nsecond\nthird\n");
  await session.prompt("Inspect @context.txt:2-2");
  expect(userText(session.messages)).toContain("second");
  expect(userText(session.messages)).not.toContain("third");
  await session.prompt("Inspect @context.txt:2-2 again");
  expect(userText(session.messages)).toBe("Inspect @context.txt:2-2 again");
  await session.prompt("Inspect @context.txt");
  expect(userText(session.messages)).toContain("third");
});

test.each(["compaction", "tree navigation"])("reattaches file context after %s", async (change) => {
  const { session } = await fixture();
  await session.prompt("Start.");
  const anchor = session.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
  await session.prompt("Inspect @context.txt");
  await session.prompt("Inspect @context.txt again");
  expect(userText(session.messages)).toBe("Inspect @context.txt again");

  if (change === "compaction") {
    session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0 } });
    await session.compact();
  } else {
    await session.navigateTree(anchor.id, { summarize: false });
  }
  await session.prompt("Inspect @context.txt after changing history");
  expect(userText(session.messages)).toContain("FILE_BODY_FIXTURE");
});

test("skips unresolved and unreadable references without changing ordinary input", async () => {
  const { session, cwd, errors } = await fixture();
  rmSync(join(cwd, "skills", "triage", "SKILL.md"));
  const original = "Inspect @missing.txt with $skill:triage $skill:missing $prompt:missing";
  await session.prompt(original);
  expect(userText(session.messages)).toBe(original);
  expect(errors).toEqual([]);

  writeFileSync(join(cwd, "missing.txt"), "NOW_PRESENT_FIXTURE");
  await session.prompt("Inspect @missing.txt");
  expect(userText(session.messages)).toContain("NOW_PRESENT_FIXTURE");
});

test("deduplicates repeated references in one input", async () => {
  const { session } = await fixture();
  const original = `${prompt} @context.txt $skill:triage. $prompt:review!`;
  await session.prompt(original);
  expectAttached(userText(session.messages), original);
});

test("replayed attachments remain hidden when prompt normalization changes whitespace", async () => {
  const { session, cwd } = await fixture([], { assembled: true });
  writeFileSync(join(cwd, "context.txt"), "FILE_BODY_FIXTURE  \n");
  await session.prompt(prompt);
  await session.prompt(userText(session.messages));
  const rendered = renderUser(session);
  expect(rendered).toContain(prompt);
  expect(rendered).not.toContain("FILE_BODY_FIXTURE");
  expect(rendered).not.toContain("SKILL_BODY_FIXTURE");
});

test("preserves quoted context markers in the original message and referenced files", async () => {
  const { session, cwd } = await fixture();
  const example = '<pi-bites-inline-context id="00000000-0000-4000-8000-000000000000">';
  writeFileSync(
    join(cwd, "context.txt"),
    `FILE_BODY_FIXTURE\n${example}\n</pi-bites-inline-context>`,
  );
  const original = `Explain this literal tag: ${example} then inspect @context.txt`;
  await session.prompt(original);
  const text = userText(session.messages);
  expect(text.startsWith(original)).toBe(true);
  const rendered = renderUser(session);
  expect(rendered).toContain("Explain this literal tag:");
  expect(rendered).toContain("then inspect @context.txt");
  expect(rendered).not.toContain("FILE_BODY_FIXTURE");
});

test.each([
  ["Inspect @context.txt", "Inspect @context.txt"],
  ["/forward @context.txt", "Review @context.txt"],
])("reference bodies stay hidden and untrusted after expanding %s", async (input, visible) => {
  const { session, cwd, reviews, errors } = await fixture([], { reviewer: true });
  writeFileSync(join(cwd, "context.txt"), "ATTACHED_CONTENT_IS_NOT_HUMAN_AUTHORIZATION");
  let calls = 0;
  session.agent.streamFunction = (model) =>
    calls++ === 0
      ? response(
          model,
          [{ type: "toolCall", id: "review", name: "review_probe", arguments: {} }],
          "toolUse",
        )
      : response(model);
  await session.prompt(input);

  expect(errors).toEqual([]);
  expect(userText(session.messages)).toContain("ATTACHED_CONTENT_IS_NOT_HUMAN_AUTHORIZATION");
  expect(renderUser(session)).toContain(visible);
  expect(renderUser(session)).not.toContain("ATTACHED_CONTENT_IS_NOT_HUMAN_AUTHORIZATION");
  expect(reviews).toHaveLength(1);
  const packet = userText(reviews[0]!);
  expect(packet).toContain(visible);
  expect(packet).not.toContain("ATTACHED_CONTENT_IS_NOT_HUMAN_AUTHORIZATION");
});

test("skill-relative references use the skill directory, not its provenance root", async () => {
  const { session, cwd } = await fixture();
  await session.prompt("Use $skill:triage");
  expect(userText(session.messages)).toContain(
    `References are relative to ${join(cwd, "skills", "triage")}.`,
  );
  expect(userText(session.messages)).not.toContain(`References are relative to ${cwd}.`);
});

test.each(["steer", "followUp"] as const)(
  "resubmitting discarded %s input still delivers its file context",
  async (queue) => {
    const { session, requests } = await fixture();
    await session[queue]("Inspect @context.txt");
    const removed = session.clearQueue();
    const restored = queue === "steer" ? removed.steering[0]! : removed.followUp[0]!;
    await session.prompt(restored);

    expect(persistedUserText(session)).toContain("FILE_BODY_FIXTURE");
    expect(userText(requests[0]!)).toContain("FILE_BODY_FIXTURE");
    expect(renderUser(session)).toContain("Inspect @context.txt");
    expect(renderUser(session)).not.toContain("FILE_BODY_FIXTURE");
  },
);

test("resolves references in extension-origin user messages", async () => {
  const { session, requests, errors } = await fixture();
  await session.prompt(prompt, { source: "extension", expandPromptTemplates: false });
  expect(errors).toEqual([]);
  expectAttached(persistedUserText(session));
  expectAttached(userText(requests[0]!));
  expect(renderUser(session)).not.toContain("SKILL_BODY_FIXTURE");
});

test("resolves references introduced by a native prompt template", async () => {
  const { session, requests } = await fixture();
  await session.prompt("/chain");
  expectAttached(persistedUserText(session));
  expectAttached(userText(requests[0]!));
  expect(renderUser(session)).not.toContain("SKILL_BODY_FIXTURE");
});

test("native templates that discard arguments do not cache their discarded references", async () => {
  const { session, requests } = await fixture();
  await session.prompt("/drop @context.txt");
  expect(persistedUserText(session)).toBe("No arguments.");
  await session.prompt("Inspect @context.txt");
  expect(persistedUserText(session)).toContain("FILE_BODY_FIXTURE");
  expect(userText(requests.at(-1)!)).toContain("FILE_BODY_FIXTURE");
});

test("restored native skill messages hide context after skill-block parsing trims the separator", async () => {
  const { session, cwd, requests } = await fixture();
  writeFileSync(
    join(cwd, "skills", "triage", "SKILL.md"),
    "---\nname: triage\ndescription: Triage\n---\nRead @context.txt.",
  );
  await session.prompt("/skill:triage");
  expect(persistedUserText(session)).toContain("FILE_BODY_FIXTURE");
  expect(userText(requests[0]!)).toContain("FILE_BODY_FIXTURE");

  const parsed = parseSkillBlock(persistedUserText(session));
  if (!parsed?.userMessage) throw new Error("Expected an attached user-message portion");
  initTheme("dark", false);
  const rendered = new UserMessageComponent(
    parsed.userMessage,
    undefined,
    0,
    session.extensionRunner.getMarkdownTransformers(),
  )
    .render(160)
    .join("\n");
  expect(rendered).not.toContain("FILE_BODY_FIXTURE");
  expect(rendered).not.toContain("pi-bites-inline-context");
});
