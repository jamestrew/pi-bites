import { extractText } from "../message-text.js";
import { Container } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

type ReceiptName = "spawn_agent" | "send_message" | "followup_task";
type ReceiptArgs = {
  task_name?: string;
  target?: string;
  message?: string;
  agent_type?: string;
  model?: string;
  reasoning_effort?: string;
};

type ModelDefaults = { defaultModel?: string; defaultReasoningEffort?: string };
type ReceiptState = {
  defaults?: ModelDefaults;
  error?: string;
  receipt?: Partial<
    Record<"task_name" | "subagentType" | "modelName" | "thinking" | "target" | "status", string>
  >;
};

/** These calls are receipts, not live child activity trackers. Keep the host's padded shell. */
export function taskReceiptRenderers(name: ReceiptName, getModelDefaults?: () => ModelDefaults) {
  return {
    renderCall(
      args: ReceiptArgs,
      theme: { bold(s: string): string; fg(color: "accent" | "dim", s: string): string },
      context: { expanded: boolean; state: ReceiptState },
    ) {
      const { expanded, state } = context;
      state.defaults ??= { ...getModelDefaults?.() };
      return {
        render(width: number) {
          const saved = state.receipt;
          const role = saved ? saved.subagentType : args.agent_type;
          const model = saved ? saved.modelName : (args.model ?? state.defaults?.defaultModel);
          const thinking = saved
            ? saved.thinking
            : (args.reasoning_effort ?? state.defaults?.defaultReasoningEffort);
          const summary =
            name === "spawn_agent"
              ? [saved?.task_name ?? args.task_name, role && `${role}:`, model, thinking]
                  .filter(Boolean)
                  .join(" ")
              : `→ ${saved?.target ?? args.target ?? ""}${saved?.status ? ` ${saved.status}` : ""}`;
          const lines = [
            fitLine(
              theme.bold(name) + theme.fg("accent", ` ${sanitizeSingleLine(summary)}`),
              width,
            ),
          ];
          const message = args.message ? wrapDisplayLines(args.message, width) : [];
          if (message.length) {
            lines.push(
              "",
              ...(expanded ? message : message.slice(0, 3)).map((line) =>
                fitLine(theme.fg("dim", line), width),
              ),
            );
          }
          if (state.error)
            lines.push(
              "",
              ...wrapDisplayLines(state.error, width).map((line) =>
                fitLine(theme.fg("dim", line), width),
              ),
            );
          if (!expanded && message.length > 3) {
            let hint = "ctrl+o to expand";
            try {
              hint = keyHint("app.tools.expand", "to expand");
            } catch {
              /* Print mode has no keybindings. */
            }
            lines.push(fitLine(theme.fg("dim", `(${hint})`), width));
          }
          return lines;
        },
        invalidate() {},
      };
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      options: { isPartial?: boolean },
      _theme: unknown,
      context: { state: ReceiptState; isError: boolean },
    ) {
      if (context.isError) {
        const error = extractText(result.content);
        const concise = sanitizeSingleLine(
          error.split("\n").find((line) => line.trim()) ?? "Operation failed",
        );
        context.state.error = concise.startsWith("Error:") ? concise : `Error: ${concise}`;
        context.state.receipt = undefined;
      } else if (!options.isPartial) {
        context.state.error = undefined;
        const details = result.details as Record<string, unknown> | undefined;
        const receipt: NonNullable<ReceiptState["receipt"]> = {};
        for (const key of [
          "task_name",
          "subagentType",
          "modelName",
          "thinking",
          "target",
          "status",
        ] as const) {
          if (typeof details?.[key] === "string") receipt[key] = details[key];
        }
        if (name === "spawn_agent" && !receipt.task_name) {
          try {
            const value: unknown = JSON.parse(extractText(result.content));
            if (
              value &&
              typeof value === "object" &&
              "task_name" in value &&
              typeof value.task_name === "string"
            )
              receipt.task_name = value.task_name;
          } catch {
            /* Saved V1 spawn results have no canonical task path. */
          }
        }
        context.state.receipt = receipt;
      }
      // Pi calls renderCall before renderResult. The call component reads shared state
      // at render time, so this final update is visible without another invalidation.
      return new Container();
    },
  };
}
