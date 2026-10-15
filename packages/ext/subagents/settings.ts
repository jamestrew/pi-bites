import type { SubagentsConfig } from "../config.js";

export type SubagentsSettings = SubagentsConfig;

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setModelDefaults?: (
    defaults: Pick<SubagentsSettings, "defaultModel" | "defaultReasoningEffort">,
  ) => void;
  setMaxDepth?: (n: number | undefined) => void;
  setMaxConcurrent: (n: number | undefined) => void;
  setFleetView: (b: boolean) => void;
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  appliers.setModelDefaults?.({
    defaultModel: s.defaultModel,
    defaultReasoningEffort: s.defaultReasoningEffort,
  });
  appliers.setMaxDepth?.(s.maxDepth);
  appliers.setMaxConcurrent(s.maxConcurrent);
  appliers.setFleetView(s.fleetView ?? true);
}
