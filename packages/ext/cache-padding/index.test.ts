import { describe, expect, test, vi } from "vitest";
import registerCachePadding, {
  padProviderPayload,
  padSystemPrompt,
  padToolInfo,
  padToolRecords,
} from "./index.js";

const parameters = {
  type: "object",
  properties: { path: { type: "string", description: "Repository-relative file path" } },
};
const descriptions = {
  bash: "Execute a shell command and return stdout, stderr, and exit status.",
  read: "Read a file from disk with optional line offsets.",
  edit: "Replace exact text in an existing file.",
  write: "Create or overwrite a file.",
  Agent: "Launch a delegated agent for a self-contained task.",
  MessageAgent: "Send additional context to a running agent.",
};

const anthropicTools = Object.entries(descriptions).map(([name, description]) => ({
  name,
  description: description.repeat(20),
  input_schema: parameters,
}));

const estimatedTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

describe("cache padding", () => {
  test("starts enabled and persists an explicit runtime override", async () => {
    const on = vi.fn();
    const appendEntry = vi.fn();
    const registerCommand = vi.fn();
    const preview = registerCachePadding({ on, appendEntry, registerCommand } as never);
    const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1] as (
      event: unknown,
      ctx: { sessionManager: { getBranch: () => unknown[] } },
    ) => void;
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;
    };

    sessionStart({}, { sessionManager: { getBranch: () => [] } });
    expect(preview.systemPrompt("Base prompt. ".repeat(800))).toContain(
      "# Coding-agent operating guidance",
    );

    await command.handler("off", { ui: { notify: vi.fn() } });
    expect(preview.systemPrompt("Base prompt")).toBe("Base prompt");
    expect(appendEntry).toHaveBeenCalledWith("cache-padding", { enabled: false });
  });

  test("pads the prompt and Anthropic tool definitions just above the cache threshold", () => {
    const prompt = padSystemPrompt("Base coding-agent prompt. ".repeat(400));
    const tools = padToolRecords(anthropicTools);

    expect(Math.ceil(prompt.length / 4)).toBeGreaterThanOrEqual(4_900);
    expect(Math.ceil(prompt.length / 4)).toBeLessThan(5_200);
    expect(estimatedTokens(tools)).toBeGreaterThanOrEqual(4_200);
    expect(estimatedTokens(tools)).toBeLessThan(4_500);
    expect(padSystemPrompt(prompt).match(/# Coding-agent operating guidance/g)).toHaveLength(1);
  });

  test("supports OpenAI nested function definitions without mutating the payload", () => {
    const payload = {
      model: "gpt-test",
      tools: anthropicTools.map(({ input_schema, ...tool }) => ({
        type: "function",
        function: { ...tool, parameters: input_schema },
      })),
    };
    const padded = padProviderPayload(payload) as typeof payload;

    expect(padded).not.toBe(payload);
    expect(padded.tools[0]?.function.description).toContain("Use bash for shell-native work");
    expect(payload.tools[0]?.function.description).not.toContain("Use bash for shell-native work");
  });

  test("previews the same expanded descriptions used in provider payloads", () => {
    const sourceInfo = {
      path: "<builtin:read>",
      source: "builtin",
      scope: "temporary" as const,
      origin: "top-level" as const,
    };
    const tools = anthropicTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      promptGuidelines: [],
      sourceInfo,
    }));

    const activeNames = tools.map((tool) => tool.name);
    const firstTool = tools[0];
    if (!firstTool) throw new Error("Expected tool fixture");
    const inactive = { ...firstTool, name: "inactive", description: "x".repeat(20_000) };
    const padded = padToolInfo([...tools, inactive], activeNames).filter((tool) =>
      activeNames.includes(tool.name),
    );

    expect(padded[0]?.description).toContain("Use bash for shell-native work");
    expect(
      estimatedTokens(
        padded.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      ),
    ).toBeGreaterThanOrEqual(4_200);
  });
});
