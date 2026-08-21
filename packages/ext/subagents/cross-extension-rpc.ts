/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import type { SpawnOptions } from "./agent-manager.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { ThinkingLevel } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelRegistry(value: unknown): value is ModelRegistry {
  return isRecord(value) && typeof value.find === "function" && typeof value.getAll === "function";
}

const RPC_SPAWN_OPTION_KEYS = new Set([
  "description",
  "model",
  "isolated",
  "inheritContext",
  "thinkingLevel",
  "isolation",
  "cwd",
]);
const THINKING_LEVELS = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ThinkingLevel, true>;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

export function decodeSpawnOptions(raw: unknown, registry?: ModelRegistry): SpawnOptions {
  const input = raw ?? {};
  if (!isRecord(input)) throw new Error("Spawn RPC options must be an object");

  for (const key of Object.keys(input)) {
    if (!RPC_SPAWN_OPTION_KEYS.has(key)) throw new Error(`Unknown Spawn RPC option: ${key}`);
  }

  const options: SpawnOptions = { description: "" };
  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      throw new Error("Spawn RPC option description must be a string");
    }
    options.description = input.description;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== "string") throw new Error("Spawn RPC option model must be a string");
    if (!registry) {
      throw new Error(
        `Model override "${input.model}" provided but ctx.modelRegistry is unavailable`,
      );
    }
    const model = resolveModel(input.model, registry);
    if (typeof model === "string") throw new Error(model);
    options.model = model;
  }
  for (const key of ["isolated", "inheritContext"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") {
      throw new Error(`Spawn RPC option ${key} must be a boolean`);
    }
    options[key] = input[key];
  }
  if (input.thinkingLevel !== undefined) {
    if (!isThinkingLevel(input.thinkingLevel)) {
      throw new Error("Spawn RPC option thinkingLevel is invalid");
    }
    options.thinkingLevel = input.thinkingLevel;
  }
  if (input.isolation !== undefined) {
    if (input.isolation !== "worktree") throw new Error("Spawn RPC option isolation is invalid");
    options.isolation = input.isolation;
  }
  if (input.cwd !== undefined && input.cwd !== null) {
    if (typeof input.cwd !== "string") throw new Error("Spawn RPC option cwd must be a string");
    options.cwd = input.cwd;
  }
  return options;
}

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 3;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: SpawnOptions): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown; // passed through to manager.spawn
  getCtx: () => unknown; // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc(
  events: EventBus,
  channel: string,
  fn: (params: Record<string, unknown>) => unknown,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || !("requestId" in raw)) return;
    const params = raw as Record<string, unknown>;
    if (typeof params.requestId !== "string") return;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: unknown) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc(events, "subagents:rpc:spawn", (params) => {
    const { type, prompt, options } = params;
    if (typeof type !== "string" || typeof prompt !== "string") {
      throw new Error("Spawn RPC requires string type and prompt");
    }
    const ctx = getCtx();
    if (!ctx) throw new Error("No active session");

    const registry =
      isRecord(ctx) && isModelRegistry(ctx.modelRegistry) ? ctx.modelRegistry : undefined;
    return { id: manager.spawn(pi, ctx, type, prompt, decodeSpawnOptions(options, registry)) };
  });

  const unsubStop = handleRpc(events, "subagents:rpc:stop", ({ agentId }) => {
    if (typeof agentId !== "string") throw new Error("Stop RPC requires string agentId");
    if (!manager.abort(agentId)) throw new Error("Agent not found");
  });

  return { unsubPing, unsubSpawn, unsubStop };
}
