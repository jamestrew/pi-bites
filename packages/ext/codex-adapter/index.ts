import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BitesConfig } from "../config.js";
import {
  isAdapterModel,
  reconcileTools,
  type AdapterModel,
  type AdapterToolState,
} from "./activation.js";
import { registerApplyPatchTool } from "./apply-patch/tool.js";
import { registerExecCommandTool } from "./exec/command-tool.js";
import { createExecSessionManager } from "./exec/session-manager.js";
import { registerWriteStdinTool } from "./exec/write-stdin-tool.js";
import { buildToolGuidance } from "./prompt-guidance.js";

export default function registerCodexAdapter(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  const state: AdapterToolState = {};
  const sessions = createExecSessionManager();

  const reconcile = (model: AdapterModel | undefined) => {
    const providers = configRef.current.codexAdapter?.providers ?? [];
    pi.setActiveTools(reconcileTools(pi.getActiveTools(), isAdapterModel(model, providers), state));
  };

  registerApplyPatchTool(pi);
  registerExecCommandTool(pi, sessions);
  registerWriteStdinTool(pi, sessions);
  pi.on("session_start", (_event, ctx) => reconcile(ctx.model));
  pi.on("model_select", (event) => reconcile(event.model));
  pi.on("before_agent_start", (event, ctx) => {
    const providers = configRef.current.codexAdapter?.providers ?? [];
    if (!isAdapterModel(ctx.model, providers)) return;
    const guidance = buildToolGuidance(
      event.systemPromptOptions.selectedTools ?? pi.getActiveTools(),
    );
    if (guidance === undefined) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });
  pi.on("session_shutdown", async () => {
    try {
      pi.setActiveTools(reconcileTools(pi.getActiveTools(), false, state));
    } finally {
      await sessions.shutdown();
    }
  });
}
