import { defineSubagentTool } from "./operation-context.js";
import { randomUUID } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getSendInputToolParameters } from "./agent-tool-description.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { v1Result, SubagentOperationError } from "./tool-result.js";
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

export function createSendInput(pi: ExtensionAPI, manager: AgentManager) {
  return defineSubagentTool({
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
      if (context.isError)
        Object.assign(context.state, {
          status: "failed",
          error: result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        });
      return new Container();
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const caller = ctx.callerAgentId ? manager.getRecord(ctx.callerAgentId) : undefined;
      const isParent = caller?.parentSessionId === params.target;
      const record = manager.getRecord(params.target);
      const recipient = record?.description ?? params.target;
      const result = (text: string, status: SendInputStatus, submissionId?: string) => {
        const details: SendInputDetails = {
          status,
          recipient,
          message: params.message,
          interrupt: params.interrupt ?? false,
          submissionId,
          ...(status === "failed" ? { error: text } : {}),
        };
        if (status === "failed" || !submissionId) throw new SubagentOperationError(text, details);
        return v1Result({ submission_id: submissionId }, details);
      };

      if (!record && !isParent) return result(`agent with id ${params.target} not found`, "failed");
      if (!params.message.trim())
        return result("Empty message can't be sent to an agent", "failed");
      if (params.interrupt) {
        if (isParent) return result("Parent interruption is unavailable", "failed");
        if (!record?.session || record.status !== "running")
          return result(`agent with id ${params.target} is unavailable for interruption`, "failed");
        if (!(await manager.cancelAndSteer(record.id, params.message, signal)))
          return result(`agent with id ${params.target} could not be interrupted`, "failed");

        const submissionId = randomUUID();
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return result(JSON.stringify({ submission_id: submissionId }), "interrupted", submissionId);
      }
      try {
        const accepted = isParent
          ? manager.sendParent(caller, params.message)
          : record && (await manager.sendInput(record.id, params.message, signal));
        if (!accepted) return result(`input was not submitted to agent ${params.target}`, "failed");
      } catch (error) {
        return result(
          `input was not submitted to agent ${params.target}: ${error instanceof Error ? error.message : String(error)}`,
          "failed",
        );
      }

      const submissionId = randomUUID();
      if (!isParent && record)
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
      return result(JSON.stringify({ submission_id: submissionId }), "queued", submissionId);
    },
  });
}
