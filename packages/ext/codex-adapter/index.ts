import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { AdapterModel } from "./activation.js";

export type CodexPromptPreview = (
  systemPrompt: string,
  model: AdapterModel | undefined,
  options: BuildSystemPromptOptions,
) => string;

export { default } from "./code-mode/registration.js";
