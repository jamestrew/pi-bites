import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getModelLabelFromConfig } from "./model-resolver.js";
import { WAIT_AGENT_TIMEOUT_GUIDANCE } from "./register-wait-agent.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes } from "./agent-types.js";
import { type ToolDescriptionMode } from "./settings.js";

const EXPLORE_SCOPE_GUIDANCE =
  "Partition Explore's scope before launching: keep files and searches you will handle out of its prompt. After launch, do not inspect delegated files or topics and do not repeat its searches or reads while it runs; continue only non-overlapping work, or wait if its result blocks progress.";
const CHILD_LIFECYCLE_GUIDANCE =
  "Use MessageAgent for a status check only when the reply informs a current decision. Do not use it to hurry an agent or request wrap-up because it seems slow. Reviews must reach their original completion criterion unless the user changes or cancels the task. Request wrap-up only when the task becomes unnecessary for a reason independent of elapsed time or a WaitAgent timeout.";

const COMPACT_DESCRIPTION = `Launch an autonomous agent when delegation has a concrete benefit. Each call starts a
fresh agent with no conversation memory and immediately returns an agent ID for WaitAgent or MessageAgent.

Agent types:
{{compactTypeList}}

Custom agents: .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global).

Notes:
- Use a 3-5 word description; it is shown in the UI.
- Prompts are self-contained. For investigations, include relevant context, prior checks, a concrete question, and a
  semantic completion condition ("done when ...").
- Launch independent agents together. Wait only for blocking results; otherwise accept automatic delivery.
- ${CHILD_LIFECYCLE_GUIDANCE}
- ${EXPLORE_SCOPE_GUIDANCE}
- MessageAgent reaches running agents only; it cannot resume completed agents.
- "worktree" isolation uses a temporary copy; unchanged copies are removed and changes are saved to a branch.
- Agent output is hidden from the user. Summarize relevant results and verify claimed edits.`;

const FULL_DESCRIPTION = `Launch an autonomous agent when delegation has a concrete benefit. Each call starts a
fresh agent with no conversation memory and immediately returns an agent ID for WaitAgent or MessageAgent.

Agent types:
{{typeList}}

Custom agents live in .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global). Custom agents override
defaults; project agents override global agents with the same name.

## Usage notes

- Use a 3-5 word description; it is shown in the UI.
- Launch independent agents together. Wait only when a result blocks progress; otherwise keep working and accept
  automatic delivery.
- ${CHILD_LIFECYCLE_GUIDANCE}
- ${EXPLORE_SCOPE_GUIDANCE}
- MessageAgent reaches running agents only; it cannot resume completed agents.
- "worktree" isolation uses a temporary copy; unchanged copies are removed and changes are saved to a branch.
- Agent output is hidden from the user. Summarize relevant results, and verify claimed edits before reporting them.
- Keep synthesis in the primary agent: avoid duplicating delegated searches, read decisive files yourself, and
  give write-capable agents concrete changes rather than asking them to infer a fix from their research.

## Writing the prompt

Prompts are self-contained: state the goal and why it matters, relevant paths and constraints, prior findings or
failed checks, whether to research or edit, and a checkable deliverable. Specify a concrete question and semantic
completion condition ("done when ...") for investigations, and output length when useful.

For a lookup, provide the exact command. For an investigation, provide the question and decision context rather
than brittle steps.`;

export const AGENT_PROMPT_GUIDELINES = [
  [
    "Use a specialized Agent when its description matches the task.",
    "Use general when the user requests a subagent, work can run independently in parallel, or delegation has another concrete benefit.",
    "Handle ordinary implementation directly; complexity alone does not justify general.",
    EXPLORE_SCOPE_GUIDANCE,
  ].join(" "),
  'For investigations, favor a concrete question and semantic completion condition ("done when ...") in the prompt.',
  [
    "Use direct tools for bounded lookups.",
    "Use Explore immediately for high-fanout factual retrieval, substantial documentation and third-party source reading, or when the user explicitly asks to explore; otherwise use it after 2-4 targeted calls fail, including prior checks.",
    "Keep known-path reads, direct searches likely to answer the question, and a few decisive files in the primary agent.",
    "Keep review, design, cross-file auditing, root-cause analysis, and other judgment-heavy work in the primary agent.",
    "Read decisive files and own the synthesis.",
  ].join(" "),
  `Agent returns an agent ID immediately. Wait only for blocking results; otherwise continue useful work or respond and accept automatic delivery. MessageAgent reaches running agents only and cannot resume completed agents. ${WAIT_AGENT_TIMEOUT_GUIDANCE} Never poll or sleep.`,
  CHILD_LIFECYCLE_GUIDANCE,
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
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description:
            'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Unchanged worktrees are removed automatically; changes are saved to a branch on completion.',
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
