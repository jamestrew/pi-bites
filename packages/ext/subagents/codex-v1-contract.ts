/** Pinned model-facing contract for the Codex V1 subagent migration. */

export const CODEX_V1_UPSTREAM_REVISION = "ddf8a67ab09cd76b8adc0969f11ee1271179aba7";

export const CODEX_V1_SOURCE_PATHS = [
  "codex-rs/core/src/tools/handlers/multi_agents_spec.rs",
  "codex-rs/core/src/tools/handlers/multi_agents.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_common.rs",
  "codex-rs/core/src/tools/handlers/multi_agents/spawn.rs",
  "codex-rs/core/src/tools/handlers/multi_agents/send_input.rs",
  "codex-rs/core/src/tools/handlers/multi_agents/wait.rs",
  "codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs",
  "codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs",
  "codex-rs/core/src/session/multi_agents.rs",
  "codex-rs/core/src/agent/role.rs",
  "codex-rs/core/templates/collab/experimental_prompt.md",
] as const;

export const CODEX_V1_TOKEN_BUDGET = {
  currentBaseline: 1_605,
  softFinal: 2_000,
} as const;

export const CODEX_V1_AGENT_STATUSES = [
  "pending_init",
  "running",
  "interrupted",
  "shutdown",
  "not_found",
  "completed",
  "errored",
] as const;

export const CODEX_V1_TOOL_NAMES = [
  "spawn_agent",
  "send_input",
  "wait_agent",
  "close_agent",
  "resume_agent",
] as const;

const ROLE_DESCRIPTIONS = {
  default: "Default agent.",
  explorer: `Use \`explorer\` for specific codebase questions.
Explorers are fast and authoritative.
They must be used to ask specific, well-scoped questions on the codebase.
Rules:
- In order to avoid redundant work, you should avoid exploring the same problem that explorers have already covered. Typically, you should trust the explorer results without additional verification. You are still allowed to inspect the code yourself to gain the needed context!
- You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. This allows you to get more information faster without waiting for one question to finish before asking the next. While waiting for the explorer results, you can continue working on other local tasks that do not depend on those results. This parallelism is a key advantage of delegation, so use it whenever you have multiple questions to ask.
- Reuse existing explorers for related questions.
- Pi restricts explorers to read-only tools.`,
  worker: `Use for execution and production work.
Typical tasks:
- Implement part of a feature
- Fix tests or bugs
- Split large refactors into independent chunks
Rules:
- Explicitly assign **ownership** of the task (files / responsibility). When the subtask involves code changes, you should clearly specify which files or modules the worker is responsible for. This helps avoid merge conflicts and ensures accountability. For example, you can say "Worker 1 is responsible for updating the authentication module, while Worker 2 will handle the database layer." By defining clear ownership, you can delegate more effectively and reduce coordination overhead.
- Always tell workers they are **not alone in the codebase**, and they should not revert the edits made by others, and they should adjust their implementation to accommodate the changes made by others. This is important because there may be multiple workers making changes in parallel, and they need to be aware of each other's work to avoid conflicts and ensure a cohesive final product.`,
} as const;

function formatRoleGuidance(): string {
  return `Available roles:\n${Object.entries(ROLE_DESCRIPTIONS)
    .map(([name, description]) => `${name}: {\n${description}\n}`)
    .join("\n")}`;
}

const AGENT_STATUS_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "string",
      enum: ["pending_init", "running", "interrupted", "shutdown", "not_found"],
    },
    {
      type: "object",
      properties: { completed: { type: ["string", "null"] } },
      required: ["completed"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { errored: { type: "string" } },
      required: ["errored"],
      additionalProperties: false,
    },
  ],
} as const;

const tools = {
  spawn_agent: {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent for a well-scoped task. Returns the spawned agent id plus the user-facing nickname when available. Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Initial plain-text task for the new agent.",
        },
        agent_type: {
          type: "string",
          description: `Agent type for the new agent. Omit to use \`default\`.\n${formatRoleGuidance()}`,
        },
        model: {
          type: "string",
          description:
            "Model override for the new agent. Omit unless an explicit override is needed.",
        },
        reasoning_effort: {
          type: "string",
          description:
            "Reasoning effort override for the new agent. Omit to inherit the parent effort.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Thread identifier for the spawned agent.",
        },
        nickname: {
          type: ["string", "null"],
          description: "User-facing nickname for the spawned agent when available.",
        },
      },
      required: ["agent_id", "nickname"],
      additionalProperties: false,
    },
  },
  send_input: {
    name: "send_input",
    description:
      "Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Agent id to message (from spawn_agent).",
        },
        message: {
          type: "string",
          description: "Plain-text message to send to the agent.",
        },
        interrupt: {
          type: "boolean",
          description:
            "True interrupts the current task and handles this message immediately; false or omitted queues it.",
        },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        submission_id: {
          type: "string",
          description: "Identifier for the queued input submission.",
        },
      },
      required: ["submission_id"],
      additionalProperties: false,
    },
  },
  wait_agent: {
    name: "wait_agent",
    description:
      "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          description:
            "Agent ids to wait on. Pass multiple ids to wait for whichever finishes first.",
          items: { type: "string" },
        },
        timeout_ms: {
          type: "number",
          description:
            "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000. Prefer longer waits (minutes) to avoid busy polling.",
        },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        status: {
          type: "object",
          description: "Final statuses keyed by agent id.",
          additionalProperties: AGENT_STATUS_OUTPUT_SCHEMA,
        },
        timed_out: {
          type: "boolean",
          description:
            "Whether the wait call returned due to timeout before any agent reached a final status.",
        },
      },
      required: ["status", "timed_out"],
      additionalProperties: false,
    },
  },
  close_agent: {
    name: "close_agent",
    description:
      "Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested. Don't keep agents open for too long if they are not needed anymore.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Agent id to close (from spawn_agent).",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        previous_status: {
          description: "The agent status observed before shutdown was requested.",
          allOf: [AGENT_STATUS_OUTPUT_SCHEMA],
        },
      },
      required: ["previous_status"],
      additionalProperties: false,
    },
  },
  resume_agent: {
    name: "resume_agent",
    description:
      "Resume a previously closed agent by id so it can receive send_input and wait_agent calls.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Agent id to resume.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: { status: AGENT_STATUS_OUTPUT_SCHEMA },
      required: ["status"],
      additionalProperties: false,
    },
  },
} as const;

export const CODEX_V1_CONTRACT = {
  namespace: {
    name: "multi_agent_v1",
    description: "Tools for spawning and managing sub-agents.",
  },
  roles: ROLE_DESCRIPTIONS,
  tools,
} as const;

/** Serialize every field budgeted for the final five-tool model-facing surface. */
export function serializeCodexV1Contract(): string {
  return JSON.stringify(Object.values(CODEX_V1_CONTRACT.tools));
}

/** Pi's conservative estimate: one token per four serialized characters. */
export function estimateCodexV1ContractTokens(): number {
  return Math.ceil(serializeCodexV1Contract().length / 4);
}
