import { defineTool, type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getCloseAgentToolParameters } from "./agent-tool-description.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { textResult } from "./tool-result.js";
import type { WaitAgentStatus } from "./types.js";
import type { Theme } from "./ui/agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./ui/text-lines.js";

type CloseAgentDetails = {
  target?: string;
  recipient?: string;
  status?: "closed" | "failed";
  previousStatus?: WaitAgentStatus;
  error?: string;
};

export function registerCloseAgent(pi: ExtensionAPI, manager: AgentManager): void {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.CLOSE_AGENT,
      label: "close_agent",
      description: CODEX_V1_CONTRACT.tools.close_agent.description,
      parameters: getCloseAgentToolParameters(),
      renderCall({ target }, theme, context) {
        const state = context.state as CloseAgentDetails;
        if (target && state.target !== target) {
          state.target = target;
          state.recipient = manager.getRecord(target)?.description ?? target;
        }
        return renderCloseAgent(state, context.expanded, theme);
      },
      renderResult(result, _options, _theme, context) {
        const details = result.details as CloseAgentDetails | undefined;
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
      async execute(_toolCallId, { target }) {
        const recipient = manager.getRecord(target)?.description ?? target;
        const previousStatus = await manager.close(target);
        return textResult<CloseAgentDetails>(JSON.stringify({ previous_status: previousStatus }), {
          target,
          recipient,
          status: "closed",
          previousStatus,
        });
      },
    }),
  );
}

function renderCloseAgent(state: CloseAgentDetails, expanded: boolean, theme: Theme): Component {
  return {
    render(width: number): string[] {
      const metadata = [
        sanitizeSingleLine(state.recipient ?? ""),
        state.status,
        state.previousStatus === undefined ? undefined : `was ${statusLabel(state.previousStatus)}`,
      ].filter(Boolean);
      const suffix = metadata.length > 0 ? ` ${metadata.join(" ")}` : "";
      const lines = [fitLine(theme.bold("close_agent") + theme.fg("accent", suffix), width)];
      if (state.error) {
        const details = wrapDisplayLines(`Error: ${state.error}`, Math.max(1, width));
        lines.push(
          "",
          ...(expanded ? details : details.slice(0, 8)).map((line) =>
            fitLine(theme.fg("dim", line), width),
          ),
        );
        if (!expanded && details.length > 8) {
          lines.push(
            fitLine(theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`), width),
          );
        }
      }
      return lines;
    },
    invalidate() {},
  };
}

function statusLabel(status: WaitAgentStatus): string {
  if (typeof status === "string") return status === "pending_init" ? "queued" : status;
  if ("completed" in status) return "completed";
  return "errored";
}
