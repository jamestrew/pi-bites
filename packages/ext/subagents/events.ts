import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentEventData } from "./event-data.js";
import type { SubagentsSettings } from "./settings.js";

export interface SubagentEventMap {
  "subagents:created": { id: string; type: string; description: string; isBackground: boolean };
  "subagents:started": { id: string; type: string; description: string };
  "subagents:compacted": {
    id: string;
    type: string;
    description: string;
    reason: string;
    tokensBefore: number;
    compactionCount: number;
  };
  "subagents:completed": AgentEventData;
  "subagents:failed": AgentEventData;
  "subagents:steered": { id: string; message: string };
  "subagents:ready": Record<string, never>;
  "subagents:settings_loaded": { settings: SubagentsSettings };
  "subagents:settings_changed": { settings: SubagentsSettings; persisted: boolean };
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on<K extends keyof SubagentEventMap>(
      channel: K,
      handler: (data: SubagentEventMap[K]) => void,
    ): () => void;
  }
}

export function onSubagentEvent<K extends keyof SubagentEventMap>(
  pi: ExtensionAPI,
  channel: K,
  handler: (data: SubagentEventMap[K]) => void,
): () => void {
  return pi.events.on(channel, handler);
}

export function emitSubagentEvent<K extends keyof SubagentEventMap>(
  pi: ExtensionAPI,
  channel: K,
  data: SubagentEventMap[K],
): void {
  pi.events.emit(channel, data);
}
