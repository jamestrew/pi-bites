import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentMessageDetails } from "./subagent-messages.js";
import { renderSubagentMessage } from "./ui/subagent-message-render.js";

export function registerSubagentMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">) {
  pi.registerMessageRenderer<SubagentMessageDetails>(
    "subagent-message",
    (message, { expanded }, theme) => {
      if (!message.details) return undefined;
      return renderSubagentMessage(message.details, expanded, theme);
    },
  );
}
