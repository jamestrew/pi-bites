import { createHmac } from "node:crypto";

const INPUT_FIELDS = ["input", "messages", "contents"] as const;
const INSTRUCTION_FIELDS = ["instructions", "system", "systemInstruction"] as const;
const SECTIONS = new Set<string>([
  ...INSTRUCTION_FIELDS,
  "tools",
  "toolConfig",
  "prompt_cache_key",
  "config",
]);

export type Fingerprints = {
  instructions: string;
  tools: string;
  key: string;
  options: string;
  input: string[];
  historyField: string;
};

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A logical request may have at most 2,048 items, 128 tools, 8 MiB of JSON/binary data,
// 100,000 JSON nodes and depth 64. Larger requests need a raised inspection budget.
export function fingerprint(payload: unknown, key: Buffer): Fingerprints {
  if (!object(payload) || Object.getPrototypeOf(payload) !== Object.prototype)
    throw new Error("unsupported logical payload");
  // Field names, not provider IDs: custom proxies can use the same request shapes.
  const historyField = INPUT_FIELDS.find((name) => Array.isArray(payload[name]));
  const history = historyField ? (payload[historyField] as unknown[]) : undefined;
  const toolConfig = object(payload.toolConfig) ? payload.toolConfig : undefined;
  const config = object(payload.config) ? payload.config : undefined;
  const toolGroups = [payload.tools, toolConfig?.tools, config?.tools];
  const opaqueTools = toolGroups.some((tools) => tools !== undefined && !Array.isArray(tools));
  const inputField = opaqueTools ? undefined : historyField;
  const input = inputField && history ? history : [payload];
  if (
    (history?.length ?? 0) > 2048 ||
    toolGroups.reduce<number>(
      (count, tools) => count + (Array.isArray(tools) ? tools.length : 0),
      0,
    ) > 128
  )
    throw new Error("inspection bounds exceeded");
  // Response-ID continuations do not contain the complete historical prefix.
  if (payload.previous_response_id != null) throw new Error("incomplete logical request history");
  let bytes = 0;
  let nodes = 0;
  function hash(value: unknown): string {
    const hmac = createHmac("sha256", key);
    function write(text: string | Uint8Array) {
      bytes += typeof text === "string" ? Buffer.byteLength(text) : text.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error("inspection bounds exceeded");
      hmac.update(text);
    }
    function visit(item: unknown, depth: number) {
      if (++nodes > 100_000 || depth > 64) throw new Error("inspection bounds exceeded");
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
      ) {
        write(JSON.stringify(item));
      } else if (ArrayBuffer.isView(item)) {
        write(`binary:${item.constructor.name}:${item.byteLength}:`);
        write(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
      } else if (item instanceof ArrayBuffer) {
        write(`binary:ArrayBuffer:${item.byteLength}:`);
        write(new Uint8Array(item));
      } else if (Array.isArray(item)) {
        write("[");
        for (const child of item) {
          visit(child, depth + 1);
          write(",");
        }
        write("]");
      } else if (object(item) && Object.getPrototypeOf(item) === Object.prototype) {
        write("{");
        for (const name of Object.keys(item)
          .filter((name) => item[name] !== undefined)
          .sort()) {
          write(JSON.stringify(name));
          write(":");
          visit(item[name], depth + 1);
          write(",");
        }
        write("}");
      } else {
        throw new Error("unsupported payload value");
      }
    }
    visit(value, 0);
    return hmac.digest("hex");
  }
  const field = (name: string) => (payload[name] !== undefined ? [true, payload[name]] : [false]);
  return {
    instructions: hash([
      ...INSTRUCTION_FIELDS.map(field),
      config?.systemInstruction ?? null,
      input.filter((item) => object(item) && (item.role === "system" || item.role === "developer")),
    ]),
    tools: hash(toolGroups.map((tools) => (tools === undefined ? [false] : [true, tools]))),
    key: hash(field("prompt_cache_key")),
    options: hash([
      inputField ?? "whole payload",
      Object.fromEntries(
        Object.entries(payload).filter(([name]) => name !== inputField && !SECTIONS.has(name)),
      ),
      toolConfig
        ? Object.fromEntries(Object.entries(toolConfig).filter(([name]) => name !== "tools"))
        : field("toolConfig"),
      config
        ? Object.fromEntries(
            Object.entries(config).filter(
              ([name]) => name !== "tools" && name !== "systemInstruction",
            ),
          )
        : field("config"),
    ]),
    input: input.map(hash),
    historyField: inputField ?? "whole payload",
  };
}
