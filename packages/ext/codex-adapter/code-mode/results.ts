import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateCodeModeOutput } from "./output.js";
import type { NestedTrace } from "./nested-traces.js";
import type { RuntimeResponse } from "./types.js";

export interface CodeModeDetails {
  codeMode: true;
  cellId: string;
  state: RuntimeResponse["kind"];
  failed: boolean;
  traces: NestedTrace[];
}

/** Pi persists error status via tool_result; throwing here would discard accumulated images. */
export function codeModeResult(
  response: RuntimeResponse,
  elapsed: number,
  maxTokens: number,
  traces: NestedTrace[],
): AgentToolResult<CodeModeDetails> {
  const failed = response.errorText !== undefined;
  const status =
    response.kind === "yielded"
      ? `Script running with cell ID ${response.cellId}`
      : response.kind === "terminated"
        ? "Script terminated"
        : failed
          ? "Script failed"
          : "Script completed";
  const content: AgentToolResult<CodeModeDetails>["content"] = [
    {
      type: "text",
      text: `${status}\nWall time ${(elapsed / 1000).toFixed(1)} seconds\nOutput:\n`,
    },
  ];
  const items = [...response.contentItems];
  if (failed) items.push({ type: "input_text", text: `Script error:\n${response.errorText}` });
  for (const item of truncateCodeModeOutput(items, maxTokens)) {
    if (item.type === "input_text") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(item.image_url);
    if (match?.[1] && match[2]) content.push({ type: "image", mimeType: match[1], data: match[2] });
  }
  return {
    content,
    details: { codeMode: true, cellId: response.cellId, state: response.kind, failed, traces },
  };
}
