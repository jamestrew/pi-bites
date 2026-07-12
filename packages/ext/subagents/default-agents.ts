/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./types.js";

const SELF_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../index${path.extname(fileURLToPath(import.meta.url))}`,
);

const DEFAULT_EXPLORE_MODEL = "github-copilot/gpt-5.4-mini";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general",
    {
      name: "general",
      displayName: "general",
      description: "General-purpose, write-capable agent for complex multi-step tasks.",
      builtinToolNames: ["read", "bash", "edit", "write"],
      extensions: [SELF_EXTENSION],
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      bashGatePolicy: "prompt",
      isDefault: true,
    },
  ],
  [
    "explore",
    {
      name: "explore",
      displayName: "explore",
      description: [
        "Fast read-only codebase reconnaissance in an isolated subagent.",
        "Valuable for parallelizing independent queries or protecting the main context window from large search results.",
        "Use proactively whenever an investigation spans more than a couple of files, involves tracing behavior across the codebase, or might return large output.",
        "Good candidates: tracing a call chain across many files, understanding a feature end-to-end, finding all usages of a pattern, or gathering context before a broad refactor.",
        "Bad candidates: reading a single already-known file, or a trivial grep you're confident about — use direct tools instead.",
        "When uncertain about scope, lean toward explore.",
      ].join(" "),
      builtinToolNames: ["read", "ls", "bash"],
      extensions: [SELF_EXTENSION],
      skills: true,
      model: DEFAULT_EXPLORE_MODEL,
      systemPrompt: `You are Explore, a fast read-only codebase exploration subagent running in an isolated pi process.

Your job is to investigate the repository efficiently and return objective findings to the parent agent.

=== READ-ONLY MODE ===
This is a strictly read-only task.
You must never modify files or change system state.

Do not:
- create, edit, move, copy, or delete files
- use commands or workflows that write temporary files
- propose changes as if you already made them
- read or search files outside the working directory you were given

Your role is exclusively to search, read, and inspect existing code within the provided working directory.

How to work:
- Start broad with find/grep/ls, then read the most relevant files.
- Read only the sections you need unless a full file is necessary.
- Be smart about search terms: try likely naming variants, entrypoints, and related symbols.
- You may form theories to guide your search, but do not include theories, recommendations, or strategic advice in your final answer.
- Prefer concrete evidence over guesses.
- If something is unclear, say what you checked and what remains uncertain.
- Return quickly, but do enough work to answer the requested level of thoroughness.

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
      promptMode: "replace",
      bashGatePolicy: "deny",
      isDefault: true,
    },
  ],
]);
