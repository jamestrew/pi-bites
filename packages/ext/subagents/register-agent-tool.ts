import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { summarizeToolArg, wrapMultilineText } from "../explore/index.js";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentManager } from "./agent-manager.js";
import {
  getDefaultMaxTurns,
  normalizeMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  SUBAGENT_TOOL_NAMES,
} from "./agent-runner.js";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAvailableTypes,
  resolveType,
} from "./agent-types.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { applyAndEmitLoaded, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { buildDetails, doneStats, formatLifetimeTokens, textResult } from "./tool-result.js";
import {
  type AgentInvocation,
  type AgentRecord,
  type JoinMode,
  type SubagentType,
} from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  formatMaxTurnsAbort,
  formatMs,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
} from "./ui/agent-format.js";
import { type FleetList } from "./ui/fleet-list.js";
import { type SubagentScheduler } from "./schedule.js";

type RegisterAgentToolDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  scheduler: SubagentScheduler;
  reloadCustomAgents: () => void;
  isSchedulingEnabled: () => boolean;
  isScopeModelsEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (enabled: boolean) => void;
  setScopeModelsEnabled: (enabled: boolean) => void;
  setDisableDefaultAgents: (disabled: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetViewEnabled: (enabled: boolean) => void;
  getDefaultJoinMode: () => JoinMode;
  trackBatchAgent: (id: string, joinMode: JoinMode) => void;
  updateHelperToolsActive?: () => void;
};

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}

export function registerAgentTool(pi: ExtensionAPI, deps: RegisterAgentToolDeps) {
  const {
    manager,
    agentActivity,
    fleet,
    scheduler,
    reloadCustomAgents,
    isSchedulingEnabled,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setSchedulingEnabled,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
    getDefaultJoinMode,
    trackBatchAgent,
    updateHelperToolsActive,
  } = deps;
  /** Format an agent's tool scope: "*" when it has all built-ins, else a comma-separated list. */
  const formatToolsSuffix = (cfg: { builtinToolNames?: string[] } | undefined): string => {
    const tools = cfg?.builtinToolNames;
    if (!tools || tools.length === 0) return "*";
    const isFullSet =
      tools.length === BUILTIN_TOOL_NAMES.length &&
      BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
    return isFullSet ? "*" : tools.join(", ");
  };

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () =>
    getAvailableTypes()
      .map((name) => {
        const cfg = getAgentConfig(name);
        const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
        const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
        return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
      })
      .join("\n");

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes()
      .map((name) => {
        const cfg = getAgentConfig(name);
        return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
      })
      .join("\n");

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          "Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). " +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          "Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.",
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> = isSchedulingEnabled()
    ? scheduleParamShape
    : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each. You are notified when background agents finish — never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- Foreground vs background: use foreground (default) when you need the agent's results before you can proceed. Use background when you have genuinely independent work to do in parallel.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.

- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(
        `[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`,
      );
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(
          `[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn(
        '[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"',
      );
    }
    return fullAgentToolDescription;
  })();

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.AGENT,
      label: "Agent",
      description: agentToolDescription,
      promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
      promptGuidelines: [
        [
          "Use Agent with specialized agents when the task matches an agent type's description.",
          "Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed.",
          "Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
        ].join(" "),
        [
          "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. explore).",
          "Otherwise use direct tools (read, grep, find) when the target is already known.",
        ].join(" "),
        [
          "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it.",
          "Continue with other work instead.",
        ].join(" "),
        [
          "Trust but verify: an agent's summary describes intent, not outcome.",
          "When an agent writes or edits code, check the actual changes before reporting work as done.",
        ].join(" "),
      ],
      parameters: Type.Object({
        // Put render-critical fields first so streamed tool calls don't briefly
        // display as a generic `Agent(...)` before the subagent type arrives.
        subagent_type: Type.String({
          description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
        }),
        description: Type.String({
          description: "A short (3-5 word) description of the task (shown in UI).",
        }),
        prompt: Type.String({
          description: "The task for the agent to perform.",
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            description:
              "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
          }),
        ),
        max_turns: Type.Optional(
          Type.Number({
            description:
              "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
            minimum: 1,
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            description:
              "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
          }),
        ),
        resume: Type.Optional(
          Type.String({
            description: "Optional agent ID to resume from. Continues from previous context.",
          }),
        ),
        isolated: Type.Optional(
          Type.Boolean({
            description: "If true, agent gets no extension/MCP tools — only built-in tools.",
          }),
        ),
        inherit_context: Type.Optional(
          Type.Boolean({
            description:
              "If true, fork parent conversation into the agent. Default: false (fresh context).",
          }),
        ),
        isolation: Type.Optional(
          Type.Literal("worktree", {
            description:
              'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
          }),
        ),
        ...scheduleParam,
      }),

      // ---- Custom rendering: Claude Code style ----

      renderCall(args, theme) {
        const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
        const preview =
          args.description ||
          String(args.prompt ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) ||
          "no prompt";
        const config = args.subagent_type ? getAgentConfig(args.subagent_type) : undefined;
        const model = config?.model ?? args.model;
        const thinking = config?.thinking ?? args.thinking;
        const modelSuffix = [model, thinking].filter(Boolean).join(" ");
        const suffixes = [
          modelSuffix || undefined,
          args.run_in_background ? "background" : undefined,
        ]
          .filter(Boolean)
          .map((s) => theme.fg("dim", `: ${s}`))
          .join("");
        return new Text(
          theme.fg("toolTitle", theme.bold(displayName)) +
            theme.fg("dim", `(${preview})`) +
            suffixes,
          0,
          0,
        );
      },

      renderResult(result, options, theme, context) {
        const details = result.details as AgentDetails | undefined;
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        if (!details) return new Text(resultText, 0, 0);

        const stats = (d: AgentDetails) => {
          const parts: string[] = [];
          if (d.modelName) parts.push(d.modelName);
          if (d.tags) parts.push(...d.tags);
          if (d.turnCount != null && d.turnCount > 0)
            parts.push(formatTurns(d.turnCount, d.maxTurns));
          if (d.status === "running") {
            if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
            if (d.tokens) parts.push(d.tokens);
            return parts.join(" · ");
          }
          const usage = d.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 };
          return doneStats(d.toolCalls?.length ?? d.toolUses, usage, d.durationMs);
        };

        const prefix0 = theme.fg("dim", "⎿  ");
        const indent = "   ";
        const INDENT_WIDTH = 3;

        return {
          render(width: number): string[] {
            const lineWidth = Math.max(1, width - INDENT_WIDTH);
            const lines: string[] = [];
            const statusStats = stats(details);

            if (options.expanded) {
              const prompt = String(context.args.prompt ?? "").trim();
              if (prompt) {
                lines.push(theme.fg("muted", "Prompt:"));
                for (const l of wrapTextWithAnsi(prompt, lineWidth)) lines.push(theme.fg("dim", l));
                lines.push("");
              }

              if (details.status === "running" || options.isPartial) {
                const frame = SPINNER[details.spinnerFrame ?? 0];
                lines.push(
                  theme.fg("accent", frame) +
                    (statusStats ? theme.fg("dim", ` ${statusStats}`) : ""),
                );
                lines.push(theme.fg("dim", details.activity ?? "thinking…"));
              } else if (details.status === "background") {
                lines.push(
                  theme.fg("accent", "●") +
                    theme.fg("dim", ` Running in background (ID: ${details.agentId})`),
                );
              } else if (details.status === "error") {
                lines.push(theme.fg("error", `Error: ${details.error ?? "unknown"}`));
              } else if (details.status === "stopped") {
                lines.push(theme.fg("muted", "Stopped"));
              } else if (details.status === "aborted") {
                lines.push(theme.fg("warning", formatMaxTurnsAbort(details.turnCount)));
              }

              const toolCalls = details.toolCalls ?? [];
              for (const call of toolCalls) {
                for (const l of wrapMultilineText(call, lineWidth)) lines.push(theme.fg("dim", l));
              }

              if (resultText.trim()) {
                if (lines.length > 0) lines.push("");
                for (const l of wrapTextWithAnsi(resultText.trim(), lineWidth)) lines.push(l);
              }

              lines.push("");
              if (details.status === "running" || options.isPartial) {
                lines.push(theme.fg("muted", "Running…"));
              } else if (details.status === "background") {
                lines.push(theme.fg("muted", "Background agent running…"));
              } else {
                const isDone = details.status === "completed" || details.status === "steered";
                const label = isDone ? "Done" : "Finished";
                lines.push(
                  theme.fg(isDone ? "success" : "muted", label) +
                    (statusStats ? theme.fg("muted", ` (${statusStats})`) : ""),
                );
              }
            } else if (details.status === "running" || options.isPartial) {
              const toolCalls = details.toolCalls ?? [];
              const hiddenCount = Math.max(0, toolCalls.length - 3);
              for (const call of toolCalls.slice(-3)) {
                lines.push(
                  truncateToWidth(theme.fg("dim", summarizeToolArg(call)), lineWidth, "…"),
                );
              }
              if (toolCalls.length === 0) {
                const frame = SPINNER[details.spinnerFrame ?? 0];
                lines.push(theme.fg("accent", frame));
                lines.push(
                  truncateToWidth(theme.fg("dim", details.activity ?? "thinking…"), lineWidth, "…"),
                );
              }
              lines.push(theme.fg("muted", "Running… (ctrl+o to expand)"));
              if (hiddenCount > 0) lines.push(theme.fg("muted", `+${hiddenCount} more tool uses`));
            } else if (details.status === "background") {
              lines.push(
                theme.fg("accent", "●") +
                  theme.fg("dim", ` Running in background (ID: ${details.agentId})`),
              );
            } else if (details.status === "error") {
              lines.push(theme.fg("error", `Error: ${details.error ?? "unknown"}`));
            } else if (details.status === "stopped") {
              lines.push(theme.fg("muted", "Stopped"));
            } else if (details.status === "aborted") {
              lines.push(theme.fg("warning", formatMaxTurnsAbort(details.turnCount)));
            } else {
              const isDone = details.status === "completed" || details.status === "steered";
              lines.push(
                theme.fg(isDone ? "success" : "warning", "Done") +
                  (statusStats ? theme.fg("muted", ` (${statusStats})`) : ""),
              );
              if ((details.toolCalls?.length ?? 0) > 0)
                lines.push(theme.fg("muted", "(ctrl+o to expand)"));
            }

            return lines.map((l, i) => (i === 0 ? prefix0 + l : indent + l));
          },
          invalidate() {},
        };
      },

      // ---- Execute ----

      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        // Reload custom agents so new .pi/agents/*.md files are picked up without restart
        reloadCustomAgents();

        const rawType = params.subagent_type as SubagentType;
        const resolved = resolveType(rawType);
        const subagentType = resolved ?? "general-purpose";
        const fellBack = resolved === undefined;

        const displayName = getDisplayName(subagentType);

        // Get agent config (if any)
        const customConfig = getAgentConfig(subagentType);

        const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

        // Resolve model from agent config first; tool-call params only fill gaps.
        let model = ctx.model;
        if (resolvedConfig.modelInput) {
          const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
          if (typeof resolved === "string") {
            if (resolvedConfig.modelFromParams) return textResult(resolved);
            // config-specified: silent fallback to parent
          } else {
            model = resolved;
          }
        }

        // Scope validation: the effective resolved model is checked against the
        // user's enabledModels list (read in `enabled-models.ts`).
        //
        // Design: scopeModels guards against *runtime* LLM choices, not user-level config.
        //   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
        //     out-of-scope choice; surface it so it picks differently).
        //   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
        //     user authored/installed this agent or chose the parent's model; trust it).
        // See SubagentsSettings.scopeModels docstring for the full policy.
        if (isScopeModelsEnabled() && model) {
          const allowed = resolveEnabledModels(
            readEnabledModels(ctx.cwd),
            ctx.modelRegistry,
            ctx.cwd,
          );
          if (allowed && !isModelInScope(model, allowed)) {
            if (resolvedConfig.modelFromParams) {
              const list = [...allowed]
                .sort()
                .map((m) => `  ${m}`)
                .join("\n");
              return textResult(
                `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
                  `Allowed models (from enabledModels):\n${list}`,
              );
            }
            // Frontmatter-pinned or parent-inherited: warn + proceed.
            const agentLabel = customConfig?.displayName ?? subagentType;
            const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
            ctx.ui.notify(
              `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
              "warning",
            );
          }
        }

        const thinking = resolvedConfig.thinking;
        const inheritContext = resolvedConfig.inheritContext;
        const runInBackground = resolvedConfig.runInBackground;
        const isolated = resolvedConfig.isolated;
        const isolation = resolvedConfig.isolation;

        const parentModelId = ctx.model?.id;
        const effectiveModelId = model?.id;
        const modelName =
          effectiveModelId && effectiveModelId !== parentModelId
            ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
            : undefined;
        const effectiveMaxTurns = normalizeMaxTurns(
          resolvedConfig.maxTurns ?? getDefaultMaxTurns(),
        );
        const agentInvocation: AgentInvocation = {
          modelName,
          thinking,
          // Explicit value only — the default fallback would just add noise.
          // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
          maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
          isolated,
          inheritContext,
          runInBackground,
          isolation,
        };
        // Tool-result render shows the mode label too; viewer's header already does.
        const modeLabel = getPromptModeLabel(subagentType);
        const { tags: invocationTags } = buildInvocationTags(agentInvocation);
        const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
        const detailBase = {
          displayName,
          description: params.description,
          subagentType,
          modelName,
          tags: agentTags.length > 0 ? agentTags : undefined,
        };

        // ---- Schedule: register a job, don't spawn now ----
        if (params.schedule) {
          if (!isSchedulingEnabled()) {
            return textResult(
              "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.",
            );
          }
          if (params.resume) {
            return textResult(
              "Cannot combine `schedule` with `resume` — schedules create fresh agents.",
            );
          }
          if (params.inherit_context) {
            return textResult(
              "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
            );
          }
          if (params.run_in_background === false) {
            return textResult(
              "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
            );
          }
          if (!scheduler.isActive()) {
            return textResult(
              "Scheduler is not active in this session yet. Try again after the session has fully started.",
            );
          }
          try {
            const job = scheduler.addJob({
              name: params.description as string,
              description: params.description as string,
              schedule: params.schedule as string,
              subagent_type: subagentType,
              prompt: params.prompt as string,
              model: params.model as string | undefined,
              thinking: thinking,
              max_turns: effectiveMaxTurns,
              isolated: isolated,
              isolation: isolation,
            });
            const next = scheduler.getNextRun(job.id);
            return textResult(
              `Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
                `Next run: ${next ?? "(unknown)"}. ` +
                `Manage via /agents → Scheduled jobs.`,
            );
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err));
          }
        }

        // Resume existing agent
        if (params.resume) {
          const existing = manager.getRecord(params.resume);
          if (!existing) {
            return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
          }
          if (!existing.session) {
            return textResult(`Agent "${params.resume}" has no active session to resume.`);
          }
          const record = await manager.resume(params.resume, params.prompt, signal);
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }
          return textResult(
            record.result?.trim() || record.error?.trim() || "No output.",
            buildDetails(detailBase, record),
          );
        }

        // Background execution
        if (runInBackground) {
          const { state: bgState, callbacks: bgCallbacks } =
            createActivityTracker(effectiveMaxTurns);

          // Wrap onSessionCreated to wire output file streaming.
          // The callback lazily reads record.outputFile (set right after spawn)
          // rather than closing over a value that doesn't exist yet.
          let id: string;
          const origBgOnSession = bgCallbacks.onSessionCreated;
          bgCallbacks.onSessionCreated = (session: any) => {
            origBgOnSession(session);
            const rec = manager.getRecord(id);
            if (rec?.outputFile) {
              rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
            }
          };

          try {
            id = manager.spawn(pi, ctx, subagentType, params.prompt, {
              description: params.description,
              model,
              maxTurns: effectiveMaxTurns,
              isolated,
              inheritContext,
              thinkingLevel: thinking,
              isBackground: true,
              isolation,
              invocation: agentInvocation,
              ...bgCallbacks,
            });
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err));
          }

          // Set output file + join mode synchronously after spawn, before the
          // event loop yields — onSessionCreated is async so this is safe.
          const joinMode = resolveJoinMode(getDefaultJoinMode(), true);
          const record = manager.getRecord(id);
          if (record && joinMode) {
            record.joinMode = joinMode;
            record.toolCallId = toolCallId;
            record.outputFile = createOutputFilePath(
              ctx.cwd,
              id,
              ctx.sessionManager.getSessionId(),
            );
            writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
          }

          if (joinMode == null || joinMode === "async") {
            // Foreground/no join mode or explicit async — not part of any batch
          } else {
            // smart or group — add to current batch
            trackBatchAgent(id, joinMode);
          }

          agentActivity.set(id, bgState);
          fleet.ensureTimer();
          fleet.update();

          // Emit created event
          pi.events.emit("subagents:created", {
            id,
            type: subagentType,
            description: params.description,
            isBackground: true,
          });
          updateHelperToolsActive?.();

          const isQueued = record?.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "started"} in background.\n` +
              `Agent ID: ${id}\n` +
              `Type: ${displayName}\n` +
              `Description: ${params.description}\n` +
              (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
              (isQueued
                ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n`
                : "") +
              `\nYou will be notified when this agent completes.\n` +
              `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
              `Do not duplicate this agent's work.`,
            {
              ...detailBase,
              toolUses: 0,
              tokens: "",
              durationMs: 0,
              status: "background" as const,
              agentId: id,
            },
          );
        }

        // Foreground (synchronous) execution — stream progress via onUpdate
        let spinnerFrame = 0;
        const startedAt = Date.now();
        let fgId: string | undefined;

        const streamUpdate = () => {
          const details: AgentDetails = {
            ...detailBase,
            toolUses: fgState.toolUses,
            tokens: formatLifetimeTokens(fgState),
            turnCount: fgState.turnCount,
            maxTurns: fgState.maxTurns,
            durationMs: Date.now() - startedAt,
            status: "running",
            activity: describeActivity(fgState.activeTools, fgState.responseText),
            spinnerFrame: spinnerFrame % SPINNER.length,
            toolCalls: fgState.toolCalls,
            lifetimeUsage: fgState.lifetimeUsage,
          };
          onUpdate?.({
            content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
            details: details as any,
          });
        };

        const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
          effectiveMaxTurns,
          streamUpdate,
        );

        // Wire session creation: register in FleetView + stream to output file.
        // The output file path is set synchronously after spawn (below),
        // before onSessionCreated fires — same pattern as background agents.
        const origOnSession = fgCallbacks.onSessionCreated;
        fgCallbacks.onSessionCreated = (session: any) => {
          origOnSession(session);
          for (const a of manager.listAgents()) {
            if (a.session === session) {
              fgId = a.id;
              agentActivity.set(a.id, fgState);
              break;
            }
          }
          // Stream conversation to output file (foreground agent logging)
          if (fgId) {
            const rec = manager.getRecord(fgId);
            if (rec?.outputFile) {
              rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
            }
          }
        };

        // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
        const spinnerInterval = setInterval(() => {
          spinnerFrame++;
          streamUpdate();
        }, 80);

        streamUpdate();

        let record: AgentRecord;
        try {
          const fgResult = await manager.spawnAndWait(
            pi,
            ctx,
            subagentType,
            params.prompt,
            {
              description: params.description,
              model,
              maxTurns: effectiveMaxTurns,
              isolated,
              inheritContext,
              thinkingLevel: thinking,
              isolation,
              invocation: agentInvocation,
              signal,
              ...fgCallbacks,
            },
            (fgAgentId) => {
              // onSpawned: called synchronously after spawn, before onSessionCreated fires.
              // Set up the output file so streamToOutputFile can pick it up.
              const fgRec = manager.getRecord(fgAgentId);
              if (fgRec) {
                fgRec.outputFile = createOutputFilePath(
                  ctx.cwd,
                  fgAgentId,
                  ctx.sessionManager.getSessionId(),
                );
                writeInitialEntry(fgRec.outputFile, fgAgentId, params.prompt, ctx.cwd);
              }
            },
          );
          record = fgResult.record;
        } catch (err) {
          clearInterval(spinnerInterval);
          return textResult(err instanceof Error ? err.message : String(err));
        }

        clearInterval(spinnerInterval);

        // Clean up foreground agent from FleetView
        if (fgId) {
          agentActivity.delete(fgId);
          fleet.onAgentFinished(fgId);
        }

        // Get final token count
        const tokenText = formatLifetimeTokens(fgState);

        const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });

        // "general-purpose" may itself be unregistered (defaults disabled, no
        // user override) — getConfig then uses the hardcoded fallback config.
        const fallbackNote = fellBack
          ? `Note: Unknown agent type "${rawType}" — using ${resolveType("general-purpose") ? "general-purpose" : "the fallback agent config"}.\n\n`
          : "";

        if (record.status === "error") {
          return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
        }

        const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
        const statsParts = [`${record.toolUses} tool uses`];
        if (tokenText) statsParts.push(tokenText);
        return textResult(
          `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
            (record.result?.trim() || "No output."),
          details,
        );
      },
    }),
  );
}
