import registerCodeMode from "./code-mode/registration.js";
import type { BashGateController } from "../bash-gate/index.js";

// #302 removes this temporary gate and the legacy registration after #301 rendering is ready.
const CODE_MODE_READY = false;

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BitesConfig } from "../config.js";
import {
  isAdapterModel,
  reconcileTools,
  type AdapterModel,
  type AdapterToolState,
} from "./legacy-activation.js";
import { registerApplyPatchTool } from "./apply-patch/tool.js";
import { registerExecCommandTool } from "./exec/command-tool.js";
import { createExecSessionManager } from "./exec/session-manager.js";
import { registerWriteStdinTool } from "./exec/write-stdin-tool.js";
import { buildExecSkillGuidance, buildToolGuidance } from "./prompt-guidance.js";
import { isWebRunAvailable, registerWebRunTool } from "./web-run/tool.js";
import { registerViewImageTool } from "./view-image/tool.js";

export type CodexPromptPreview = (
  systemPrompt: string,
  model: AdapterModel | undefined,
  options: BuildSystemPromptOptions,
) => string;

export default function registerCodexAdapter(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
  gate?: BashGateController,
): CodexPromptPreview {
  // oxlint-disable-next-line no-unnecessary-condition -- temporary integration gate removed by #302.
  if (CODE_MODE_READY) return registerCodeMode(pi, configRef, gate);
  const state: AdapterToolState = {};
  const sessions = createExecSessionManager();

  const reconcile = (model: AdapterModel | undefined) => {
    const config = configRef.current.codexAdapter ?? {};
    pi.setActiveTools(
      reconcileTools(pi.getActiveTools(), isAdapterModel(model, config.providers ?? []), state, {
        webRun: isWebRunAvailable(model, config),
        viewImage: model?.input?.includes("image") === true,
      }),
    );
  };

  registerApplyPatchTool(pi);
  registerExecCommandTool(pi, sessions);
  registerWriteStdinTool(pi, sessions);
  registerViewImageTool(pi);
  registerWebRunTool(pi, { getConfig: () => configRef.current.codexAdapter ?? {} });
  const previewPrompt: CodexPromptPreview = (systemPrompt, model, options) => {
    const providers = configRef.current.codexAdapter?.providers ?? [];
    if (!isAdapterModel(model, providers)) return systemPrompt;
    const activeTools = options.selectedTools ?? pi.getActiveTools();
    const additions = [
      systemPrompt.includes("<pi-bites-tool-guidance>")
        ? undefined
        : buildToolGuidance(activeTools),
      systemPrompt.includes("<available_skills>")
        ? undefined
        : buildExecSkillGuidance(options.skills ?? [], activeTools),
    ].filter((addition) => addition !== undefined);
    return additions.length === 0 ? systemPrompt : `${systemPrompt}\n\n${additions.join("\n\n")}`;
  };
  pi.on("session_start", (_event, ctx) => reconcile(ctx.model));
  pi.on("model_select", (event) => reconcile(event.model));
  pi.on("before_agent_start", (event, ctx) => {
    const systemPrompt = previewPrompt(event.systemPrompt, ctx.model, event.systemPromptOptions);
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });
  pi.on("session_shutdown", async () => {
    try {
      pi.setActiveTools(reconcileTools(pi.getActiveTools(), false, state));
    } finally {
      await sessions.shutdown();
    }
  });
  return previewPrompt;
}
