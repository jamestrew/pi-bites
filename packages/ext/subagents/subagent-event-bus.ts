import { EventEmitter } from "node:events";
import type { EventBus } from "@earendil-works/pi-coding-agent";

const APPROVAL_CHANNEL = "subagents:bash_gate:approval";
const SHARED_CHANNELS = new Set([
  APPROVAL_CHANNEL,
  "bites:bash_gate",
  "bites:bash_gate_resolved",
  "subagents:completed",
  "subagents:failed",
]);

function isShared(channel: string): boolean {
  return SHARED_CHANNELS.has(channel) || channel.startsWith(`${APPROVAL_CHANNEL}:`);
}

export function createSubagentEventBus(parent: EventBus): EventBus {
  const emitter = new EventEmitter();
  const local: EventBus = {
    emit: (channel, data) => emitter.emit(channel, data),
    on: (channel, handler) => {
      const safeHandler = (data: unknown) => {
        try {
          const result: unknown = handler(data);
          if (result instanceof Promise)
            void result.catch((error: unknown) =>
              console.error(`Event handler error (${channel}):`, error),
            );
        } catch (error) {
          console.error(`Event handler error (${channel}):`, error);
        }
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
  };
  return {
    emit(channel, data) {
      local.emit(channel, data);
      if (isShared(channel)) parent.emit(channel, data);
    },
    on(channel, handler) {
      const unsubscribeLocal = local.on(channel, handler);
      const unsubscribeParent = isShared(channel) ? parent.on(channel, handler) : () => {};
      return () => {
        unsubscribeLocal();
        unsubscribeParent();
      };
    },
  };
}
