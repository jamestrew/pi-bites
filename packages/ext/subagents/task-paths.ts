import type { AgentManager } from "./agent-manager.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentContext } from "./operation-context.js";
import type { SpawnOptions } from "./types.js";
import { getAgentSessionId } from "./agent-tree.js";
import type { AgentRecord } from "./types.js";

export function validateTaskName(name: string): void {
  if (!name) throw new Error("agent_name must not be empty");
  if (["root", ".", ".."].includes(name)) throw new Error(`agent_name \`${name}\` is reserved`);
  if (name.includes("/")) throw new Error("agent_name must not contain `/`");
  if (!/^[a-z0-9_]+$/.test(name))
    throw new Error("agent_name must use only lowercase letters, digits, and underscores");
}

/** Paths are convenience addresses; every lookup still checks root-tree membership. */
export class TaskPaths {
  constructor(private records: () => AgentRecord[]) {}

  caller(sessionId: string): { rootId: string; path: string } {
    const record = this.records().find((r) => getAgentSessionId(r) === sessionId);
    if (record && !record.taskName) throw new Error("Calling agent has no task path");
    return { rootId: record?.rootSessionId ?? sessionId, path: record?.taskName ?? "/root" };
  }

  resolve(sessionId: string, reference: string): string {
    const { path } = this.caller(sessionId);
    const absolute = reference.startsWith("/") ? reference : `${path}/${reference}`;
    if (absolute === "/root") return absolute;
    if (!absolute.startsWith("/root/"))
      throw new Error("absolute agent paths must start with `/root`");
    for (const segment of absolute.slice(6).split("/")) validateTaskName(segment);
    return absolute;
  }

  lookup(sessionId: string, reference: string): AgentRecord {
    const { rootId } = this.caller(sessionId);
    const byId = this.records().find((r) => r.id === reference);
    const path = byId ? undefined : this.resolve(sessionId, reference);
    const record =
      byId ?? this.records().find((r) => r.rootSessionId === rootId && r.taskName === path);
    if (!record || record.rootSessionId !== rootId)
      throw new Error("Agent is not owned by this root tree");
    if (!record.taskName) throw new Error("Target agent has no task path");
    return record;
  }

  available(sessionId: string, name: string): string {
    validateTaskName(name);
    const { rootId, path } = this.caller(sessionId);
    const taskName = `${path}/${name}`;
    if (this.records().some((r) => r.rootSessionId === rootId && r.taskName === taskName))
      throw new Error(`Agent path ${taskName} is already reserved`);
    return taskName;
  }
}

/** Named spawns commit at initialized-session handoff, before the runner starts its first prompt. */
export async function spawnNamed(
  manager: AgentManager,
  pi: ExtensionAPI,
  ctx: SubagentContext,
  type: string,
  prompt: string,
  options: SpawnOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let committed = false;
  let ready!: () => void;
  const initialized = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const id = manager.spawn(pi, ctx, type, prompt, {
    ...options,
    onSessionCreated: (session) => {
      signal?.throwIfAborted();
      committed = true;
      options.onSessionCreated?.(session);
      ready();
    },
  });
  const record = manager.getRecord(id);
  if (!record) throw new Error("Spawned agent is unavailable");
  const cancel = () => {
    if (!committed) record.abortController?.abort(signal?.reason);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await Promise.race([
      initialized,
      record.promise?.then(() => {
        if (!committed) throw new Error(record.error ?? "Agent initialization failed");
      }),
    ]);
    return id;
  } catch (error) {
    await manager.close(id);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
