import { AsyncLocalStorage } from "node:async_hooks";

const STORAGE_KEY = Symbol.for("pi-bites:subagent-context");

function storage(): AsyncLocalStorage<unknown> {
  const existing: unknown = Reflect.get(globalThis, STORAGE_KEY);
  if (existing instanceof AsyncLocalStorage) return existing;
  const created = new AsyncLocalStorage<unknown>();
  Reflect.set(globalThis, STORAGE_KEY, created);
  return created;
}

export function getActiveSubagent(): string | undefined {
  const active = storage().getStore();
  return typeof active === "string" ? active : undefined;
}

export function runAsSubagent<T>(type: string, fn: () => T): T {
  return storage().run(type, fn);
}
