import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getSendInputToolParameters } from "./agent-tool-description.js";
import { steerAgent, SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { textResult } from "./tool-result.js";
import {
  renderSendInputCall,
  type SendInputRenderState,
  type SendInputStatus,
} from "./ui/send-input-render.js";

type SendInputDetails = {
  status: SendInputStatus;
  recipient: string;
  message: string;
  interrupt: boolean;
  submissionId?: string;
  error?: string;
};

export function registerSendInput(pi: ExtensionAPI, manager: AgentManager) {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.SEND_INPUT,
      label: "send_input",
      description: CODEX_V1_CONTRACT.tools.send_input.description,
      parameters: getSendInputToolParameters(),
      renderCall({ target, message, interrupt }, theme, context) {
        const state = context.state as Partial<SendInputRenderState> & { target?: string };
        if (target && state.target !== target) {
          state.target = target;
          state.recipient = manager.getRecord(target)?.description ?? target;
        }
        state.message = typeof message === "string" ? message : "";
        state.interrupt = interrupt === true;
        return renderSendInputCall(state as SendInputRenderState, context.expanded, theme);
      },
      renderResult(result, _options, _theme, context) {
        const details = result.details as SendInputDetails | undefined;
        if (details) Object.assign(context.state, details);
        return new Container();
      },
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.target);
        const recipient = record?.description ?? params.target;
        const result = (text: string, status: SendInputStatus, submissionId?: string) =>
          textResult<SendInputDetails>(text, {
            status,
            recipient,
            message: params.message,
            interrupt: params.interrupt ?? false,
            submissionId,
            ...(status === "failed" ? { error: text } : {}),
          });

        if (!record) return result(`agent with id ${params.target} not found`, "failed");
        if (!params.message.trim())
          return result("Empty message can't be sent to an agent", "failed");
        if (record.status !== "running" && record.status !== "queued")
          return result(
            `agent with id ${params.target} is unavailable (status: ${record.status})`,
            "failed",
          );
        if (params.interrupt) {
          if (!record.session || record.status !== "running")
            return result(
              `agent with id ${params.target} is unavailable for interruption`,
              "failed",
            );
          if (!manager.cancelAndSteer(record.id, params.message))
            return result(`agent with id ${params.target} could not be interrupted`, "failed");

          const submissionId = randomUUID();
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return result(
            JSON.stringify({ submission_id: submissionId }),
            "interrupted",
            submissionId,
          );
        }
        if (record.session && record.status === "running") {
          try {
            await steerAgent(record.session, params.message);
          } catch (error) {
            return result(
              `input was not submitted to agent ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
              "failed",
            );
          }
        } else if (!manager.steer(record.id, params.message)) {
          return result(`input was not submitted to agent ${record.id}`, "failed");
        }

        const submissionId = randomUUID();
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return result(JSON.stringify({ submission_id: submissionId }), "queued", submissionId);
      },
    }),
  );
}
