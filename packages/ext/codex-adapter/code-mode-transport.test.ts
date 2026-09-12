import type { Model, Tool, StreamFunction } from "@earendil-works/pi-ai";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  createGrammarToolInputProperties,
  getGrammarToolInput,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import { expect, test, vi } from "vitest";
import registerCodeMode from "./code-mode/registration.js";

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
    },
  );
}
