import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentController } from "./operations.js";

export type RegisterCollaboration = (
  pi: ExtensionAPI,
  getAllowedTools?: () => string[],
) => SubagentController;

import { AsyncLocalStorage } from "node:async_hooks";

const STORAGE_KEY = Symbol.for("pi-bites:subagent-context");
const COLLABORATION_KEY = Symbol.for("pi-bites:subagent-collaboration");

function storage(key = STORAGE_KEY): AsyncLocalStorage<unknown> {
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing instanceof AsyncLocalStorage) return existing;
  const created = new AsyncLocalStorage<unknown>();
  Reflect.set(globalThis, key, created);
  return created;
}

export function getActiveSubagent(): string | undefined {
  const active = storage().getStore();
  return typeof active === "string" ? active : undefined;
}

export function runAsSubagent<T>(
  type: string | { type: string; registerCollaboration?: RegisterCollaboration },
  fn: () => T,
): T {
  // Keep the global role marker string-compatible: discovery may evaluate an older
  // installed entrypoint before the resource loader filters it out.
  const role = typeof type === "string" ? type : type.type;
  const register = typeof type === "string" ? undefined : type.registerCollaboration;
  return storage().run(role, () => storage(COLLABORATION_KEY).run(register, fn));
}

export function getChildCollaboration(): RegisterCollaboration | undefined {
  return storage(COLLABORATION_KEY).getStore() as RegisterCollaboration | undefined;
}
