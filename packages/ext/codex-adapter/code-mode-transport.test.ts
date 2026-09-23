import {
  normalizeContext,
  type JsonValue,
  type Model,
  type Tool,
  type StreamFunction,
} from "@earendil-works/pi-ai";
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
import { parseHostMessage } from "./code-mode/host-protocol.js";
import { v1Result } from "../subagents/tool-result.js";

test("readonly JSON arguments and subagent results cross the host protocol", () => {
  const input = { items: ["one", { enabled: true }, null] } as const satisfies JsonValue;
  const result = v1Result({ status: { child: { completed: "done" } }, timed_out: false }, {});
  result.value satisfies JsonValue;
  result.content satisfies JsonValue;
  expect(
    parseHostMessage({
      type: "delegate/request",
      id: 1,
      sessionId: "session",
      request: {
        type: "tool/invoke",
        invocation: {
          cell_id: "cell",
          runtime_tool_call_id: "call",
          tool_kind: "function",
          tool_name: { name: "test" },
          input,
        },
      },
    }),
  ).toMatchObject({
    request: { invocation: { input: { items: ["one", { enabled: true }, null] } } },
  });
  expect(
    parseHostMessage({
      type: "operation/response",
      id: 1,
      result: { status: "ok", value: result.value },
    }),
  ).toEqual({
    type: "operation/response",
    id: 1,
    result: { status: "ok", value: { status: { child: { completed: "done" } }, timed_out: false } },
  });
});

function registered(disabled = false, active = true) {
  const handlers: ((event: any, ctx: any) => unknown)[] = [];
  const tools = new Map<string, Tool>();
  registerCodeMode(
    {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        if (name === "before_provider_request") handlers.push(handler);
      },
      getActiveTools: () => (active ? ["exec", "wait"] : []),
      registerMarkdownTransformer: vi.fn(),
    } as never,
    { current: { disable: disabled ? ["codexAdapter"] : [] } },
  );
  return {
    tools: [tools.get("exec")!, tools.get("wait")!],
    async request(payload: unknown, model: Model<any>) {
      for (const handler of handlers) {
        payload =
          (await handler({ type: "before_provider_request", payload }, { model })) ?? payload;
      }
      return payload;
    },
  };
}

test("stock Responses round-trips raw grammar source and keeps stock structured fallback", () => {
  const { tools } = registered();
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
  test.each([
    { grammar: true, disabled: false, active: true, id: "gpt-6" },
    { grammar: false, disabled: false, active: true, id: "gpt-6" },
    { grammar: true, disabled: true, active: true, id: "gpt-6" },
    { grammar: true, disabled: false, active: false, id: "gpt-6" },
    { grammar: true, disabled: false, active: true, id: "gpt-5.4" },
  ])(
    `${api} payload: grammar=$grammar disabled=$disabled active=$active model=$id`,
    async ({ grammar: supportsOpenAIGrammarTools, disabled, active, id }) => {
      const { tools, request } = registered(disabled, active);
      const model = {
        id,
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
      let expected: any;
      const onPayload = async (value: unknown) => {
        expected = structuredClone(value);
        if (api === "openai-codex-responses" && !disabled && active && id === "gpt-6") {
          expected.tools[1].strict = false;
        }
        payload = await request(value, model);
        throw new Error("captured before network");
      };
      await (stream as StreamFunction<any>)(model, normalizeContext({ messages: [], tools }), {
        apiKey: jwt,
        transport: "sse",
        onPayload,
      }).result();
      expect(payload).toBeDefined();
      expect(payload).toEqual(expected);
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
        expect(payload.tools[1].strict).toBe(!disabled && active && id === "gpt-6" ? false : null);
        expect(payload.tools[1].parameters.required).toEqual(["cell_id"]);
        expect(payload.tools[1].parameters.additionalProperties).toBe(false);
      }
      const initial = payload;
      const discovery = {
        role: "toolResult",
        toolCallId: "lookup",
        toolName: "exec",
        content: [
          { type: "text", text: "discovered documentation" },
          { type: "text", text: "  citeturn1view0\n" },
        ],
        isError: false,
        timestamp: 0,
      };
      await (stream as StreamFunction<any>)(
        model,
        normalizeContext({
          systemPrompt: "stable project instructions",
          messages: [discovery as never],
          tools,
        }),
        {
          apiKey: jwt,
          transport: "sse",
          onPayload,
        },
      ).result();
      expect(payload).toEqual(expected);
      expect(payload.tools).toEqual(initial.tools);
      const subsequent = payload;
      await (stream as StreamFunction<any>)(
        model,
        normalizeContext({
          systemPrompt: "stable project instructions",
          messages: [],
          tools,
        }),
        {
          apiKey: jwt,
          transport: "sse",
          onPayload,
        },
      ).result();
      expect(payload).toEqual(expected);
      expect(subsequent.instructions).toEqual(payload.instructions);
      if (api === "openai-completions") expect(subsequent.messages[0]).toEqual(payload.messages[0]);
    },
  );
}
