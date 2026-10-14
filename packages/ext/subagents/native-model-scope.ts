import { AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Owner = ExtensionContext["sessionManager"];
type Listener = (models: ExtensionContext["scopedModels"]) => void;
let active: ReturnType<typeof install> | undefined;

function install() {
  // Keep the native receiver: the wrapper calls this method with its owning session.
  // oxlint-disable-next-line typescript/unbound-method
  const original = AgentSession.prototype.setScopedModels;
  const listeners = new Map<Owner, Set<Listener>>();
  function notifyScope(this: AgentSession, models: Parameters<typeof original>[0]) {
    original.call(this, models);
    for (const listener of listeners.get(this.sessionManager) ?? []) listener(this.scopedModels);
  }
  AgentSession.prototype.setScopedModels = notifyScope;
  return { original, notifyScope, listeners };
}

/** Pi 1.0.4 emits no scope-edit event. Remove this hook when it provides one. */
export function observeNativeModelScope(owner: Owner, listener: Listener): () => void {
  const state = (active ??= install());
  const observers = state.listeners.get(owner) ?? new Set<Listener>();
  observers.add(listener);
  state.listeners.set(owner, observers);
  return () => {
    observers.delete(listener);
    if (!observers.size) state.listeners.delete(owner);
    if (!state.listeners.size) {
      if (AgentSession.prototype.setScopedModels === state.notifyScope)
        AgentSession.prototype.setScopedModels = state.original;
      if (active === state) active = undefined;
    }
  };
}
