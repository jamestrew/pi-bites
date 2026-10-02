/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are the only available subagent roles.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, SubagentType } from "./types.js";
import { CODEX_V2_CONTRACT } from "./codex-v2-contract.js";

const SELF_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../index${path.extname(fileURLToPath(import.meta.url))}`,
);

export const DEFAULT_AGENTS: Readonly<Record<SubagentType, AgentConfig>> = Object.freeze({
  default: Object.freeze({
    name: "default",
    displayName: "default",
    description: CODEX_V2_CONTRACT.roles.default,
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  worker: Object.freeze({
    name: "worker",
    displayName: "worker",
    description: CODEX_V2_CONTRACT.roles.worker,
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  explorer: Object.freeze({
    name: "explorer",
    displayName: "explorer",
    description: CODEX_V2_CONTRACT.roles.explorer,
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
});
