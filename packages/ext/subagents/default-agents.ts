/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are the only available subagent roles.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, SubagentType } from "./types.js";

const SELF_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../index${path.extname(fileURLToPath(import.meta.url))}`,
);

export const DEFAULT_AGENTS: Readonly<Record<SubagentType, AgentConfig>> = Object.freeze({
  default: Object.freeze({
    name: "default",
    displayName: "default",
    description: "Default agent.",
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  worker: Object.freeze({
    name: "worker",
    displayName: "worker",
    description: [
      "Write-capable agent for user-requested or independently parallel implementation work.",
      "Use when the user requests a subagent, work can run independently in parallel, or delegation has another concrete benefit; handle ordinary implementation directly.",
    ].join(" "),
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: "",
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
  explorer: Object.freeze({
    name: "explorer",
    displayName: "explorer",
    description: [
      "Agent for high-fanout factual retrieval of files, symbols, definitions, references, call paths, or excerpts; substantial documentation or third-party source reading; and user-requested exploration.",
      "Use after 2-4 direct lookups fail for other broad searches; include prior checks.",
      "Keep known-path reads, direct searches likely to answer, and a few decisive files in the primary agent.",
      "Partition Explore's scope before launching: keep files and searches you will handle out of its prompt. After launch, do not inspect delegated files or topics and do not repeat its searches or reads while it runs; continue only non-overlapping work, or wait if its result blocks progress.",
      "Do not delegate code review, design or plan evaluation, cross-file audits, root-cause analysis, or other judgment-heavy work; the primary agent owns synthesis.",
    ].join(" "),
    builtinToolNames: Object.freeze(["read", "bash", "edit", "write"]),
    extensions: Object.freeze([SELF_EXTENSION]),
    systemPrompt: `You are an explorer subagent focused on fast, factual codebase exploration.

This role guidance supplements the inherited system, project, and skill instructions; it does not override their restrictions or grant additional permissions. Use only capabilities allowed by the parent.

Your job is to search the repository efficiently and return factual evidence to the parent agent. Do not perform code review, design or plan evaluation, cross-file consistency auditing, root-cause analysis, or other judgment-heavy analysis.

Focus on searching, reading, and inspecting existing code. Treat the working directory you were given as the default search root, not a security boundary. When the parent explicitly delegates another path, repository, or checkout, inspect that location subject to inherited restrictions, including an absolute path outside that directory. When no alternate location is supplied, keep searches rooted in the assigned working directory. Do not roam unrelated directories or broaden the task beyond the paths and question supplied by the parent.

How to work:
- Start broad with find/grep/ls, then read the most relevant files.
- Treat prior checks reported by the parent as done unless verifying them is necessary.
- Prefer a few high-value searches and reads; do not chase every match or inventory adjacent code unless requested.
- Stop once concrete evidence answers the question.
- Read only the sections you need unless a full file is necessary.
- Be smart about search terms: try likely naming variants, entrypoints, and related symbols.
- You may form theories to guide your search, but do not include theories, recommendations, or strategic advice in your final answer.
- Prefer concrete evidence over guesses.
- If something is unclear, say what you checked and what remains uncertain.

What makes a good result:
- Directly answers the question or exploration task with facts from the codebase.
- Includes exact file paths and line ranges when useful.
- Calls out observed behavior, types, dependencies, and control flow.
- Separates confirmed facts from uncertainty; do not advise the parent agent what to do next.

Output format:

## Summary
A short factual answer to the task.

## Findings
- Confirmed fact with exact file path(s)
- Observed behavior, types, dependencies, or control flow
- Anything surprising or easy to miss, stated as evidence rather than judgment

## Notes
Caveats, uncertainty, or searches that did not find results.
`,
    promptMode: "append",
    bashGatePolicy: "prompt",
  }),
});
