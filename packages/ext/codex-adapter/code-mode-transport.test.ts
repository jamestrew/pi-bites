import type { Model, Tool, StreamFunction, ToolResultMessage } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  createGrammarToolInputProperties,
  getGrammarToolInput,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import { expect, test, vi } from "vitest";
import registerCodeMode from "./index.js";
import { codeModeResult } from "./code-mode/results.js";

function registered() {
  const tools = new Map<string, Tool>();
  registerCodeMode(
    {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      on: vi.fn(),
      registerMarkdownTransformer: vi.fn(),
    } as never,
    { current: {} },
  );
  return [tools.get("exec")!, tools.get("wait")!];
}

test("stock Responses round-trips raw grammar source and keeps stock structured fallback", () => {
  const tools = registered();
  expect(convertResponsesTools(tools, { supportsOpenAIGrammarTools: true })).toMatchObject([
    { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark" } },
    { type: "function", name: "wait", parameters: { required: ["cell_id"] } },
  ]);
  const mapping = createGrammarToolInputProperties(tools, true);
  expect(mapping.get("exec")).toBe("code");
  const source = '// @exec: {"yield_time_ms":1}\ntext("raw");';
  expect(getGrammarToolInput("exec", { code: source }, mapping.get("exec")!)).toBe(source);
  expect(convertResponsesTools(tools, { supportsOpenAIGrammarTools: false })).toMatchObject([
    {
      type: "function",
      name: "exec",
      parameters: { required: ["code"], properties: { code: { type: "string" } } },
    },
    { type: "function", name: "wait" },
  ]);
});

for (const [api, stream] of [
  ["openai-responses", responses],
  ["openai-codex-responses", codex],
  ["openai-completions", completions],
] as const) {
  test.each([true, false])(
    `${api} uses actual grammar capability (%s) in the provider payload`,
    async (supportsOpenAIGrammarTools) => {
      const tools = registered();
      const model = {
        id: "gpt-6",
        name: "test",
        api,
        provider: "test",
        baseUrl: "https://example.invalid/v1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
        compat: { supportsOpenAIGrammarTools },
      } as Model<any>;
      const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
      let payload: any;
      await (stream as StreamFunction<any>)(
        model,
        { messages: [], tools },
        {
          apiKey: jwt,
          transport: "sse",
          onPayload(value) {
            payload = value;
            throw new Error("captured before network");
          },
        },
      ).result();
      expect(payload).toBeDefined();
      expect(payload.tools[0].type).toBe(supportsOpenAIGrammarTools ? "custom" : "function");
      if (supportsOpenAIGrammarTools) {
        const format =
          api === "openai-completions"
            ? payload.tools[0].custom.format.grammar
            : payload.tools[0].format;
        expect(format.syntax).toBe("lark");
        expect(format.definition).toContain("PRAGMA_LINE");
      }
      expect(payload.tools[1].type).toBe("function");
      if (api === "openai-codex-responses") {
        expect(payload.tools[1].strict).toBe(false);
        expect(payload.tools[1].parameters.required).toEqual(["cell_id"]);
        expect(payload.tools[1].parameters.additionalProperties).toBe(false);
      }
      const initial = payload;
      const discovery = {
        role: "toolResult",
        toolCallId: "lookup",
        toolName: "exec",
        content: [{ type: "text", text: "discovered documentation" }],
        isError: false,
        timestamp: 0,
      };
      await (stream as StreamFunction<any>)(
        model,
        {
          systemPrompt: "stable project instructions",
          messages: [discovery as never],
          tools,
        },
        {
          apiKey: jwt,
          transport: "sse",
          onPayload(value) {
            payload = value;
            throw new Error("captured before network");
          },
        },
      ).result();
      expect(payload.tools).toEqual(initial.tools);
      const subsequent = payload;
      await (stream as StreamFunction<any>)(
        model,
        {
          systemPrompt: "stable project instructions",
          messages: [],
          tools,
        },
        {
          apiKey: jwt,
          transport: "sse",
          onPayload(value) {
            payload = value;
            throw new Error("captured before network");
          },
        },
      ).result();
      expect(subsequent.instructions).toEqual(payload.instructions);
      if (api === "openai-completions") expect(subsequent.messages[0]).toEqual(payload.messages[0]);
    },
  );
}

async function resultPayload(
  api: "openai-responses" | "openai-codex-responses",
  toolName: "exec" | "wait",
  content: ToolResultMessage["content"],
  { images = true, grammar = true, isError = false } = {},
) {
  const model = {
    id: "gpt-6",
    name: "test",
    api,
    provider: "test",
    baseUrl: "https://example.invalid/v1",
    input: images ? ["text", "image"] : ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1000,
    compat: { supportsOpenAIGrammarTools: grammar },
  } as Model<any>;
  const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
  let payload: any;
  await ((api === "openai-responses" ? responses : codex) as StreamFunction<any>)(
    model,
    {
      tools: registered(),
      messages: [
        { role: "toolResult", toolCallId: "call", toolName, content, isError, timestamp: 0 },
      ],
    },
    {
      apiKey: jwt,
      transport: "sse",
      onPayload(value) {
        payload = value;
        throw new Error("captured before network");
      },
    },
  ).result();
  expect(payload).toBeDefined();
  return payload.input.find((item: any) => item.call_id === "call");
}

test.each(["exec", "wait"] as const)(
  "Codex preserves %s text content items on the wire",
  async (toolName) => {
    expect(
      await resultPayload("openai-codex-responses", toolName, [
        { type: "text", text: "Script completed\nOutput:\n" },
        { type: "text", text: "  actual output\n" },
      ]),
    ).toEqual({
      type: toolName === "exec" ? "custom_tool_call_output" : "function_call_output",
      call_id: "call",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: "  actual output\n" },
      ],
    });
  },
);

const mixedContent: ToolResultMessage["content"] = [
  { type: "text", text: "before\n" },
  { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  { type: "text", text: "\nciteturn1view0 【1†link】 L1: [wordlim: 200]" },
];

test.each([true, false])("Codex preserves mixed item order with grammar=%s", async (grammar) => {
  expect(await resultPayload("openai-codex-responses", "exec", mixedContent, { grammar })).toEqual({
    type: grammar ? "custom_tool_call_output" : "function_call_output",
    call_id: "call",
    output: [
      { type: "input_text", text: "before\n" },
      { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
      { type: "input_text", text: "\nciteturn1view0 【1†link】 L1: [wordlim: 200]" },
    ],
  });
});

test("ordinary Responses retains its existing joined-text and image packaging", async () => {
  expect((await resultPayload("openai-responses", "exec", mixedContent)).output).toEqual([
    { type: "input_text", text: "before\n\n\nciteturn1view0 【1†link】 L1: [wordlim: 200]" },
    { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
  ]);
  expect(
    (
      await resultPayload("openai-responses", "wait", [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ])
    ).output,
  ).toBe("one\ntwo");
  expect((await resultPayload("openai-responses", "wait", [])).output).toBe("(no tool output)");
});

test("Codex retains single and empty text items, and empty results", async () => {
  expect((await resultPayload("openai-codex-responses", "wait", [])).output).toEqual([]);
  expect(
    (await resultPayload("openai-codex-responses", "wait", [{ type: "text", text: "" }])).output,
  ).toEqual([{ type: "input_text", text: "" }]);
  expect(
    (await resultPayload("openai-codex-responses", "wait", [{ type: "text", text: "one\n" }]))
      .output,
  ).toEqual([{ type: "input_text", text: "one\n" }]);
});

test("Codex retains the stock non-vision image placeholders in item order", async () => {
  expect(
    (await resultPayload("openai-codex-responses", "wait", mixedContent, { images: false })).output,
  ).toEqual([
    { type: "input_text", text: "before\n" },
    { type: "input_text", text: "(tool image omitted: model does not support images)" },
    { type: "input_text", text: "\nciteturn1view0 【1†link】 L1: [wordlim: 200]" },
  ]);
  expect(
    (await resultPayload("openai-codex-responses", "wait", [mixedContent[1]!], { images: false }))
      .output,
  ).toEqual([{ type: "input_text", text: "(tool image omitted: model does not support images)" }]);
});

test.each([false, true])(
  "Code Mode completion/error content reaches the wire unchanged (failed=%s)",
  async (failed) => {
    const result = codeModeResult(
      {
        kind: "result",
        cellId: "cell",
        contentItems: [{ type: "input_text", text: "actual output" }],
        ...(failed ? { errorText: "boom" } : {}),
      },
      100,
      1000,
      [],
    );
    expect(
      (await resultPayload("openai-codex-responses", "wait", result.content, { isError: failed }))
        .output,
    ).toEqual([
      {
        type: "input_text",
        text: `${failed ? "Script failed" : "Script completed"}\nWall time 0.1 seconds\nOutput:\n`,
      },
      { type: "input_text", text: "actual output" },
      ...(failed ? [{ type: "input_text", text: "Script error:\nboom" }] : []),
    ]);
  },
);
