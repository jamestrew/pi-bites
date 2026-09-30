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

export { default } from "./native-registration.js";
