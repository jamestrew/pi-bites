import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getModelLabelFromConfig } from "./model-resolver.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes } from "./agent-types.js";
import { type ToolDescriptionMode } from "./settings.js";

const COMPACT_DESCRIPTION = `Launch an autonomous agent when delegation has a concrete benefit. Agent types:
{{compactTypeList}}

Custom agents: .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this
  conversation.
- Handle ordinary implementation requests directly. Use general when the user requests it, independent work
  can run in parallel, or delegation has another concrete stated benefit; do not spawn it foreground just because
  work is complex or multi-step.
- Start bounded lookups with direct tools. Escalate to Explore when 2-4 targeted calls fail and broader retrieval
  is needed; include what was already checked. Use Explore immediately for clearly high-fanout searches or
  explicit requests to locate, trace, or factually map code. Do not delegate code review, design or plan evaluation,
  cross-file consistency audits, root-cause analysis, or other judgment-heavy work; synthesize the evidence yourself.
- Use foreground when you need the agent's result before continuing, especially when exploration informs your
  next steps. Use background for genuinely independent work. You are notified when background agents finish —
  never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before
  reporting work done.
- MessageAgent sends a message to a running background agent; it does not resume completed agents.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

const FULL_DESCRIPTION = `Launch a new agent when delegation has a concrete benefit. Each agent type has specific
capabilities and tools available to it.

Available agent types and the tools they have access to:
{{typeList}}

Custom agents can be defined in .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global) —
they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same
name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

Handle ordinary implementation requests directly in the primary agent. Use a general subagent when the user
explicitly requests one, independent work can run in parallel, or delegation has another concrete, stated
benefit. Do not spawn a blocking foreground general subagent merely because a task is complex or multi-step.
Continue to use specialized agents when their specialization provides a clear benefit.

Start bounded lookups with direct tools — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string.
If 2-4 targeted tool calls do not locate the answer and the next step requires broader retrieval, delegate to
Explore and include what was already checked. Use Explore immediately for broad, high-fanout searches likely to
produce excessive output, or when the user explicitly asks to locate, trace, or factually map code. Do not use
Explore for code review, design or plan evaluation, cross-file consistency auditing, root-cause analysis, or other
judgment-heavy work. The primary agent must read decisive files and perform synthesis, evaluation, recommendations,
and final technical conclusions.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses,
  with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run
  "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially —
  only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to
  show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an
  agent writes or edits code, check the actual changes before reporting work as done.
- Use foreground (run_in_background: false) when you need the agent's result before you can proceed, especially
  when exploration informs your next steps.
- Use background for genuinely independent work. You will be notified when one completes — do NOT poll or sleep
  waiting for it. Continue with other independent work or respond to the user instead.
- Every Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use MessageAgent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.),
  since it is not aware of the user's intent.
- Do not duplicate delegated exploration. Pass prior findings into the prompt, then use the result to narrow any
  source files you need to read yourself.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The
  worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned
  in the result.

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just
walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why
this task matters.

- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just
  following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead
  weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research,
implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove
you understood: include file paths, line numbers, what specifically to change.`;

export const AGENT_PROMPT_GUIDELINES = [
  [
    "Use Agent with specialized agents when the task matches an agent type's description.",
    "Use general only when the user explicitly requests it, independent work can run in parallel, or delegation has another concrete stated benefit.",
    "Handle ordinary implementation requests directly; complexity alone is not a reason to spawn a general subagent.",
    "Avoid duplicating work that subagents are already doing.",
  ].join(" "),
  [
    "Start bounded lookups with direct tools (read, grep, find).",
    "If 2-4 targeted tool calls do not locate the answer and broader retrieval is needed, delegate to Explore and pass along what was already checked.",
    "Use Explore immediately for broad high-fanout searches, symbol or reference retrieval, and explicit requests to locate, trace, or factually map code.",
    "Do not delegate code review, design or plan evaluation, cross-file consistency auditing, root-cause analysis, or other judgment-heavy work to Explore.",
    "The primary agent must read decisive files and perform synthesis, evaluation, and recommendations.",
  ].join(" "),
  "Use foreground when you need the agent's result before continuing, especially when exploration informs your next steps. Use background for genuinely independent work. You will be notified when background agents finish — do not poll or sleep.",
  "Trust but verify: check an agent's claimed code changes before reporting work as done.",
];

export function getAgentToolParameters() {
  return Type.Object(
    {
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      prompt: Type.String({ description: "The task for the agent to perform." }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Thinking level: off, minimal, low, medium, high, xhigh, max. Overrides agent default.",
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Defaults to the agent's configured mode, otherwise background. Set to false when you need the result before continuing.",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description:
            'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
        }),
      ),
    },
    { additionalProperties: false },
  );
}

function formatTools(cfg: { builtinToolNames?: string[] } | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools || tools.length === 0) return "*";

  const hasAllBuiltins =
    tools.length === BUILTIN_TOOL_NAMES.length &&
    BUILTIN_TOOL_NAMES.every((tool) => tools.includes(tool));
  return hasAllBuiltins ? "*" : tools.join(", ");
}

function buildTypeList(): string {
  return getAvailableTypes()
    .map((name) => {
      const cfg = getAgentConfig(name);
      const model = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${model} (Tools: ${formatTools(cfg)})`;
    })
    .join("\n");
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
}

function buildCompactTypeList(): string {
  return getAvailableTypes()
    .map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatTools(cfg)})`;
    })
    .join("\n");
}

function renderTemplate(template: string): string {
  const variables: Record<string, () => string> = {
    typeList: buildTypeList,
    compactTypeList: buildCompactTypeList,
    agentDir: getAgentDir,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
    const render = variables[name];
    if (render) return render();
    console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
    return raw;
  });
}

function loadCustomTemplate(): string | undefined {
  const paths = [
    join(process.cwd(), CONFIG_DIR_NAME, "agent-tool-description.md"),
    join(getAgentDir(), "agent-tool-description.md"),
  ];

  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf-8").trim();
      if (text) return text;
      console.warn(`[pi-subagents] ${path} is empty — ignoring`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pi-subagents] failed to read ${path}: ${message}`);
    }
  }

  return undefined;
}

/** Build the Agent tool description for the configured detail mode. */
export function getAgentToolDescription(mode: ToolDescriptionMode): string {
  let template = mode === "compact" ? COMPACT_DESCRIPTION : FULL_DESCRIPTION;
  if (mode === "custom") {
    const custom = loadCustomTemplate();
    if (custom) template = custom;
    else {
      console.warn(
        '[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"',
      );
    }
  }
  return renderTemplate(template);
}
