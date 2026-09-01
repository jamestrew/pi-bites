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
      "Send a message to the parent that spawned this agent. Use it only for substantive information likely " +
      "to change the parent's behavior or a question that requires a decision. Routine progress, incremental " +
      "or supporting findings, and trivial acknowledgements should wait for the final response. " +
      "Delivery is queued for the parent's next model request and does not interrupt work in progress. " +
      "This is intermediate communication and does not replace your required final response.",
    promptSnippet: "Message the parent only to change behavior or get a decision",
    promptGuidelines: [
      "Use MessageAgent only for substantive information likely to change the parent's behavior or a question that requires a decision. Routine progress, incremental or supporting findings, and trivial acknowledgements should wait for the final response.",
      "MessageAgent is intermediate-only; after using it, still return a non-empty final response summarizing your result.",
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
