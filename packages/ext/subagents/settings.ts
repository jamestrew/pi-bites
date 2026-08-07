// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JoinMode } from "./types.js";
import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

export const SubagentsSettingsSchema = Type.Object({
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
  defaultJoinMode: Type.Optional(
    Type.Union([Type.Literal("async"), Type.Literal("group"), Type.Literal("smart")]),
  ),
  /**
   * Validate runtime subagent model choices against pi's resolved session scope from
   * CLI `--models` and global/project `enabledModels`. Empty scope is unrestricted.
   * Caller-selected violations fail; frontmatter and inherited violations warn and proceed.
   */
  scopeModels: Type.Optional(Type.Boolean()),
  disableDefaultAgents: Type.Optional(Type.Boolean()),
  toolDescriptionMode: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("compact"), Type.Literal("custom")]),
  ),
  fleetView: Type.Optional(Type.Boolean()),
});

export type SubagentsSettings = Static<typeof SubagentsSettingsSchema>;
export type ToolDescriptionMode = NonNullable<SubagentsSettings["toolDescriptionMode"]>;

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setScopeModels: (enabled: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
}

/** Emit callback — the settings channels only, to keep helpers testable. */
type SettingsEventMap = {
  "subagents:settings_loaded": { settings: SubagentsSettings };
  "subagents:settings_changed": { settings: SubagentsSettings; persisted: boolean };
};
export type SettingsEmit = <K extends keyof SettingsEventMap>(
  event: K,
  payload: SettingsEventMap[K],
) => void;

export function parseSubagentsSettings(value: unknown): SubagentsSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const settings: SubagentsSettings = {};
  if (
    "maxConcurrent" in value &&
    typeof value.maxConcurrent === "number" &&
    Number.isInteger(value.maxConcurrent) &&
    value.maxConcurrent >= 1 &&
    value.maxConcurrent <= 1024
  )
    settings.maxConcurrent = value.maxConcurrent;
  if (
    "defaultJoinMode" in value &&
    (value.defaultJoinMode === "async" ||
      value.defaultJoinMode === "group" ||
      value.defaultJoinMode === "smart")
  )
    settings.defaultJoinMode = value.defaultJoinMode;
  if ("scopeModels" in value && typeof value.scopeModels === "boolean")
    settings.scopeModels = value.scopeModels;
  if ("disableDefaultAgents" in value && typeof value.disableDefaultAgents === "boolean")
    settings.disableDefaultAgents = value.disableDefaultAgents;
  if (
    "toolDescriptionMode" in value &&
    (value.toolDescriptionMode === "full" ||
      value.toolDescriptionMode === "compact" ||
      value.toolDescriptionMode === "custom")
  )
    settings.toolDescriptionMode = value.toolDescriptionMode;
  if ("fleetView" in value && typeof value.fleetView === "boolean")
    settings.fleetView = value.fleetView;
  return Value.Check(SubagentsSettingsSchema, settings) ? settings : undefined;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return parseSubagentsSettings(JSON.parse(readFileSync(path, "utf-8"))) ?? {};
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.disableDefaultAgents === "boolean")
    appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
