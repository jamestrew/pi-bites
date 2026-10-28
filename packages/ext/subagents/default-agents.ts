/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are the only available subagent roles.
 */

import type { AgentConfig, SubagentType } from "./types.js";

export const DEFAULT_AGENTS: Readonly<Record<SubagentType, AgentConfig>> = Object.freeze({
  default: Object.freeze({
    name: "default",
    displayName: "default",
    description: "Default agent.",
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  worker: Object.freeze({
    name: "worker",
    displayName: "worker",
    description:
      'Use for execution and production work.\nTypical tasks:\n- Implement part of a feature\n- Fix tests or bugs\n- Split large refactors into independent chunks\nRules:\n- Explicitly assign **ownership** of the task (files / responsibility). When the subtask involves code changes, you should clearly specify which files or modules the worker is responsible for. This helps avoid merge conflicts and ensures accountability. For example, you can say "Worker 1 is responsible for updating the authentication module, while Worker 2 will handle the database layer." By defining clear ownership, you can delegate more effectively and reduce coordination overhead.\n- Always tell workers they are **not alone in the codebase**, and they should not revert the edits made by others, and they should adjust their implementation to accommodate the changes made by others. This is important because there may be multiple workers making changes in parallel, and they need to be aware of each other\'s work to avoid conflicts and ensure a cohesive final product.',
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  explorer: Object.freeze({
    name: "explorer",
    displayName: "explorer",
    description:
      "Use `explorer` for specific codebase questions.\nExplorers are fast and authoritative.\nThey must be used to ask specific, well-scoped questions on the codebase.\nRules:\n- In order to avoid redundant work, you should avoid exploring the same problem that explorers have already covered. Typically, you should trust the explorer results without additional verification. You are still allowed to inspect the code yourself to gain the needed context!\n- You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. This allows you to get more information faster without waiting for one question to finish before asking the next. While waiting for the explorer results, you can continue working on other local tasks that do not depend on those results. This parallelism is a key advantage of delegation, so use it whenever you have multiple questions to ask.\n- Reuse existing explorers for related questions.",
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
});
