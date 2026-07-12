import { formatToolCall } from "./ui/tool-call-format.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import { type AgentActivity } from "./ui/agent-format.js";

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
export function createActivityTracker(onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    toolCalls: [],
  };

  const callbacks = {
    onToolActivity: (activity: {
      type: "start" | "end" | "call";
      toolName: string;
      arguments?: Record<string, unknown>;
    }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else if (activity.type === "end") {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      } else {
        state.toolCalls?.push(formatToolCall(activity.toolName, activity.arguments ?? {}));
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}
