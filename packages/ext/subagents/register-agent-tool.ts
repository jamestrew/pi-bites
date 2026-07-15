import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  defineTool,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createAgentToolExecute } from "./agent-tool-execute.js";
import { type AgentManager } from "./agent-manager.js";
import { buildDetails } from "./tool-result.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes } from "./agent-types.js";
import { applyAndEmitLoaded, type ToolDescriptionMode } from "./settings.js";
import { type AgentRecord, type JoinMode } from "./types.js";
import { type AgentActivity, getDisplayName } from "./ui/agent-format.js";
import { type FleetList } from "./ui/fleet-list.js";
import { renderAgentToolResult } from "./ui/agent-tool-render.js";

type RegisterAgentToolDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setScopeModelsEnabled: (enabled: boolean) => void;
  setDisableDefaultAgents: (disabled: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetViewEnabled: (enabled: boolean) => void;
  getDefaultJoinMode: () => JoinMode;
  trackSpawned: (id: string, joinMode: JoinMode) => void;
  updateHelperToolsActive?: () => void;
};

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.slice(model.lastIndexOf("/") + 1);
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}

export function registerAgentTool(pi: ExtensionAPI, deps: RegisterAgentToolDeps) {
  const {
    manager,
    agentActivity,
    fleet,
    reloadCustomAgents,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
    getDefaultJoinMode,
    trackSpawned,
    updateHelperToolsActive,
  } = deps;
  const terminalRecords = new Map<string, AgentRecord>();
  const rememberTerminalRecord = (event: { id: string }) => {
    const { id } = event;
    if (!id) return;
    const record = manager.getRecord(id);
    if (record) terminalRecords.set(id, record);
  };
  pi.events.on("subagents:completed", (data) => rememberTerminalRecord(data as { id: string }));
  pi.events.on("subagents:failed", (data) => rememberTerminalRecord(data as { id: string }));

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
      setDefaultJoinMode,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent when delegation has a concrete benefit. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Handle ordinary implementation requests directly. Use general when the user requests it, independent work can run in parallel, or delegation has another concrete stated benefit; do not spawn it foreground just because work is complex or multi-step.
- Start bounded investigations with direct tools. Escalate to Explore when 2-4 targeted calls fail and broader searching is needed; include what was already checked. Delegate immediately only for obviously broad or high-fanout work.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each. You are notified when background agents finish — never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent when delegation has a concrete benefit. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

Handle ordinary implementation requests directly in the primary agent. Use a general subagent when the user explicitly requests one, independent work can run in parallel, or delegation has another concrete, stated benefit. Do not spawn a blocking foreground general subagent merely because a task is complex or multi-step. Continue to use specialized agents when their specialization provides a clear benefit.

Start bounded investigations with direct tools — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. If 2-4 targeted tool calls do not locate the answer and the next step requires broader searching, delegate to Explore and include what was already checked. Delegate immediately only when the task is obviously broad, high-fanout, or likely to produce enough output to bloat the main context. Afterward, read only the files needed to act on or verify the findings.

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
- Do not duplicate delegated exploration. Pass prior findings into the prompt, then use the result to narrow any source files you need to read yourself.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.

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
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      const render = vars[name];
      if (render) return render();
      console.warn(
        `[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`,
      );
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), CONFIG_DIR_NAME, "agent-tool-description.md"),
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

  const renderMetadata = new Map<string, { model: string; thinking: string }>();

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.AGENT,
      label: "Agent",
      description: agentToolDescription,
      promptSnippet: "Launch autonomous sub-agents when delegation has a concrete benefit",
      promptGuidelines: [
        [
          "Use Agent with specialized agents when the task matches an agent type's description.",
          "Use general only when the user explicitly requests it, independent work can run in parallel, or delegation has another concrete stated benefit.",
          "Handle ordinary implementation requests directly; complexity alone is not a reason to spawn a blocking foreground general subagent.",
          "Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed.",
          "Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
        ].join(" "),
        [
          "Start bounded investigations with direct tools (read, grep, find).",
          "If 2-4 targeted tool calls do not locate the answer and broader searching is needed, delegate to Explore and pass along what was already checked.",
          "Delegate immediately only for obviously broad, high-fanout, or context-heavy exploration.",
          "Afterward, read only the files needed to act on or verify the findings.",
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
      }),

      // ---- Custom rendering: Claude Code style ----

      renderCall(args, theme, context) {
        const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
        const preview =
          args.description ||
          String(args.prompt).replace(/\s+/g, " ").trim().slice(0, 80) ||
          "no prompt";
        const config = args.subagent_type ? getAgentConfig(args.subagent_type) : undefined;
        const effective = renderMetadata.get(context.toolCallId);
        const model = effective?.model ?? args.model ?? config?.model;
        const thinking = effective?.thinking ?? args.thinking ?? config?.thinking;
        const modelSuffix = [model, thinking && `thinking: ${thinking}`]
          .filter(Boolean)
          .join(" · ");
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
        const details = result.details;
        const record = details?.agentId
          ? (terminalRecords.get(details.agentId) ?? manager.getRecord(details.agentId))
          : undefined;
        const currentResult =
          details && record && ["completed", "error", "stopped"].includes(record.status)
            ? {
                ...result,
                details: buildDetails(details, record, agentActivity.get(record.id)),
              }
            : result;
        return renderAgentToolResult(currentResult, options, theme, context);
      },
      execute: createAgentToolExecute({
        pi,
        manager,
        agentActivity,
        fleet,
        reloadCustomAgents,
        isScopeModelsEnabled,
        getDefaultJoinMode,
        trackSpawned,
        updateHelperToolsActive,
        setRenderMetadata: (toolCallId, model, thinking) =>
          renderMetadata.set(toolCallId, { model, thinking }),
      }),
    }),
  );
}
