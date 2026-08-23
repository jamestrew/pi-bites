import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BitesConfig } from "../config.js";
import {
  isAdapterModel,
  reconcileTools,
  type AdapterModel,
  type AdapterToolState,
} from "./activation.js";
import { registerApplyPatchTool } from "./apply-patch/tool.js";

export default function registerCodexAdapter(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  const state: AdapterToolState = {};

  const reconcile = (model: AdapterModel | undefined) => {
    const providers = configRef.current.codexAdapter?.providers ?? [];
    pi.setActiveTools(reconcileTools(pi.getActiveTools(), isAdapterModel(model, providers), state));
  };

  registerApplyPatchTool(pi);
  pi.on("session_start", (_event, ctx) => reconcile(ctx.model));
  pi.on("model_select", (event) => reconcile(event.model));
  pi.on("session_shutdown", () => {
    pi.setActiveTools(reconcileTools(pi.getActiveTools(), false, state));
  });
}
