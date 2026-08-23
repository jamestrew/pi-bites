import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { textResult } from "./tool-result.js";
import {
  renderMessageAgentCall,
  renderMessageAgentResult,
  type MessageAgentStatus,
} from "./ui/message-agent-render.js";

type ChildMessageAgentDetails = { status: MessageAgentStatus };

export function createChildMessageAgent(name: string, messageParent: (message: string) => boolean) {
  return defineTool({
    name,
    label: "MessageAgent",
    description:
      "Send a message to the parent that spawned this agent. Use this for blockers, questions, " +
      "corrected premises, conflicts, or findings that unblock the parent—not routine progress updates. " +
      "Delivery is queued for the parent's next model request and does not interrupt work in progress.",
    promptSnippet: "Message the parent only when it can unblock work",
    promptGuidelines: [
      "Use MessageAgent only for blockers, questions, corrected premises, conflicts, and findings that unblock the parent—not routine progress updates.",
    ],
    parameters: Type.Object(
      {
        message: Type.String({ description: "The message to send to the parent." }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, { message }) {
      try {
        const status: MessageAgentStatus = messageParent(message) ? "sent" : "failed";
        return textResult<ChildMessageAgentDetails>(
          status === "sent" ? "Message sent to parent." : "Failed to message parent.",
          { status },
        );
      } catch {
        return textResult<ChildMessageAgentDetails>("Failed to message parent.", {
          status: "failed",
        });
      }
    },
    renderCall({ message }, theme) {
      return renderMessageAgentCall("parent", message, theme);
    },
    renderResult(result, _options, theme) {
      return renderMessageAgentResult(result.details?.status ?? "failed", theme);
    },
  });
}
