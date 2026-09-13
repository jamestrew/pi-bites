import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getResumeAgentToolParameters } from "./agent-tool-description.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { textResult } from "./tool-result.js";
import type { WaitAgentStatus } from "./types.js";
import { lifecycleStatusLabel, renderAgentLifecycle } from "./ui/agent-lifecycle-render.js";

type ResumeAgentDetails = {
  id?: string;
  recipient?: string;
  status?: "resumed" | "failed";
  agentStatus?: WaitAgentStatus;
  error?: string;
};

export function registerResumeAgent(
  pi: ExtensionAPI,
  manager: Pick<AgentManager, "getRecord" | "getClosedRecord" | "reopen">,
  isScopeModelsEnabled: () => boolean,
  getOwnerSignal: () => AbortSignal,
): void {
  const recipientFor = (id: string): string => {
    const record = manager.getRecord(id) ?? manager.getClosedRecord(id);
    return record && "description" in record ? record.description : id;
  };
  pi.registerTool(
    defineTool({
      name: "resume_agent",
      label: "resume_agent",
      description: CODEX_V1_CONTRACT.tools.resume_agent.description,
      parameters: getResumeAgentToolParameters(),
      renderCall({ id }, theme, context) {
        const state = context.state as ResumeAgentDetails;
        if (id && state.id !== id) {
          state.id = id;
          state.recipient = recipientFor(id);
        }
        return renderAgentLifecycle(
          "resume_agent",
          () => ({
            metadata: [
              state.recipient,
              state.status,
              state.agentStatus === undefined
                ? undefined
                : lifecycleStatusLabel(state.agentStatus, "idle"),
            ],
            error: state.error,
          }),
          context.expanded,
          theme,
        );
      },
      renderResult(result, _options, _theme, context) {
        const details = result.details as ResumeAgentDetails | undefined;
        if (details) Object.assign(context.state, details);
        if (context.isError) {
          Object.assign(context.state, {
            status: "failed",
            error: result.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
          });
        }
        return new Container();
      },
      async execute(_toolCallId, { id }, signal, _onUpdate, ctx) {
        const recipient = recipientFor(id);
        const combinedSignal = AbortSignal.any([
          getOwnerSignal(),
          ...[signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined),
        ]);
        const scopeModels = isScopeModelsEnabled();
        const agentStatus = await manager.reopen(pi, ctx, id, {
          signal: combinedSignal,
          scopeModels,
        });
        return textResult<ResumeAgentDetails>(JSON.stringify({ status: agentStatus }), {
          id,
          recipient,
          status: "resumed",
          agentStatus,
        });
      },
    }),
  );
}
