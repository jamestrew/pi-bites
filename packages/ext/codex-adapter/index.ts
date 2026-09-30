import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AdapterModel } from "./activation.js";

export type CodexPromptPreview = (
  systemPrompt: string,
  model: AdapterModel | undefined,
  options: BuildSystemPromptOptions,
) => string;

export interface CodexAdapterController {
  previewPrompt: CodexPromptPreview;
  previewTools?: (tools: ToolInfo[]) => ToolInfo[];
  getAllowedTools: () => string[];
}

import { getActiveSubagent } from "../subagents/subagent-context.js";
import registerChild from "./code-mode/registration.js";
import registerParent from "./native-registration.js";

// Children retain the host until #370; there is no user-selectable runtime fallback.
export default function registerAdapter(
  ...args: Parameters<typeof registerParent>
): CodexAdapterController {
  return getActiveSubagent() ? registerChild(...args) : registerParent(...args);
}
