import {
  formatSkillsForPrompt,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BashGateController } from "../../bash-gate/index.js";
import type { BitesConfig } from "../../config.js";
import {
  isAdapterModel,
  reconcileTools,
  createAdapterToolState,
  getNestedTools,
} from "../activation.js";
import type { CodexPromptPreview } from "../index.js";
import { registerApplyPatchTool } from "../apply-patch/tool.js";
import { registerExecCommandTool } from "../exec/command-tool.js";
import { createExecSessionManager } from "../exec/session-manager.js";
import { registerWriteStdinTool } from "../exec/write-stdin-tool.js";
import { registerViewImageTool } from "../view-image/tool.js";
import { registerWebRunTool } from "../web-run/tool.js";
import { nativeTools, usesGrammar } from "./contracts.js";
import { CodeModeLifecycle } from "./lifecycle.js";
import { NestedToolBridge } from "./nested-tools.js";
import { registerCodeModeTools } from "./tools.js";

/** Internal cutover entry point. Production remains gated in index.ts until #301/#302. */
export default function registerCodeMode(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
  gate?: BashGateController,
): CodexPromptPreview {
  const state = createAdapterToolState();
  const sessions = createExecSessionManager();
  const owned = {
    apply_patch: registerApplyPatchTool(pi),
    exec_command: registerExecCommandTool(pi, sessions),
    write_stdin: registerWriteStdinTool(pi, sessions),
    view_image: registerViewImageTool(pi),
    web_run: registerWebRunTool(pi, { getConfig: () => configRef.current.codexAdapter ?? {} }),
  };
  const bridge = new NestedToolBridge(owned, gate, () => configRef.current.codexAdapter ?? {});
  let notify: ExtensionContext["ui"]["notify"] | undefined;
  const getTools = () => nativeTools(bridge.tools());
  const lifecycle = new CodeModeLifecycle(
    () => ({
      tools: getTools(),
      shells: sessions,
      onFailure: (error) => notify?.(error.message, "error"),
    }),
    (reason) => notify?.(`Code Mode cleared: ${reason}`, "info"),
  );
  const refresh = registerCodeModeTools(pi, lifecycle, bridge, getTools, owned);
  const enabled = (model: ExtensionContext["model"]) =>
    !configRef.current.disable?.includes("codexAdapter") && isAdapterModel(model);
  const reconcile = (ctx: ExtensionContext) => {
    const supported = enabled(ctx.model);
    const active = pi.getActiveTools();
    const next = reconcileTools(active, supported, state);
    const callable = supported && (next.includes("exec") || next.includes("wait"));
    lifecycle.modelSelected(callable);
    if (callable) {
      bridge.capture(ctx);
      bridge.setEnabled(getNestedTools(state));
      refresh(
        getTools().map((tool) => tool.name),
        usesGrammar(ctx.model),
      );
    } else bridge.clear();
    pi.setActiveTools(next);
  };
  const preview: CodexPromptPreview = (prompt, model, options) => {
    if (!isAdapterModel(model) || configRef.current.disable?.includes("codexAdapter"))
      return prompt;
    const active = options.selectedTools ?? pi.getActiveTools();
    if (
      !active.includes("exec") ||
      active.includes("read") ||
      !getNestedTools(state).has("exec_command")
    )
      return prompt;
    const original = "Use the read tool to load a skill's file";
    const replacement =
      "Use `exec` to load a skill's file through `tools.exec_command` and emit its contents with `text(result.output)`";
    if (prompt.includes("<available_skills>")) return prompt.replace(original, replacement);
    const skills = formatSkillsForPrompt(options.skills ?? []);
    return skills ? `${prompt}\n\n${skills.replace(original, replacement)}` : prompt;
  };
  pi.on("session_start", (_event, ctx) => {
    notify = ctx.ui.notify.bind(ctx.ui);
    bridge.clear();
    lifecycle.sessionStart(ctx, enabled(ctx.model));
    reconcile(ctx);
  });
  pi.on("model_select", (_event, ctx) => reconcile(ctx));
  pi.on("session_tree", (_event, ctx) => {
    lifecycle.branchChanged();
    bridge.clear();
    reconcile(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    reconcile(ctx);
    const prompt = preview(event.systemPrompt, ctx.model, {
      ...event.systemPromptOptions,
      selectedTools: pi.getActiveTools(),
    });
    if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
  });
  pi.on("turn_start", (_event, ctx) => reconcile(ctx));
  pi.on("session_shutdown", async (event) => {
    lifecycle.shutdown(event.reason === "reload" ? "reload" : "shutdown");
    bridge.clear();
    notify = undefined;
    try {
      pi.setActiveTools(reconcileTools(pi.getActiveTools(), false, state));
    } finally {
      await sessions.shutdown();
    }
  });
  return preview;
}
