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
      description: [
        "General-purpose, write-capable agent for delegated implementation work.",
        "Use when the user explicitly requests a subagent, independent work can run in parallel, or delegation has another concrete stated benefit.",
        "Do not use for ordinary implementation requests merely because they are complex or multi-step; handle those directly in the primary agent.",
        "Avoid blocking foreground delegation when the primary agent can do the work itself.",
      ].join(" "),
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
        "Fast read-only codebase retrieval and reconnaissance in an isolated subagent.",
        "Use for broad factual searches that locate files, symbols, definitions, references, call paths, or relevant excerpts without filling the primary context.",
        "Otherwise, use after 2-4 targeted tool calls fail to answer a bounded lookup and the next step requires broader searching; pass along what was already checked.",
        "Delegate immediately when retrieval is obviously high-fanout or likely to return excessive search output.",
        "Do not delegate code review, design or plan evaluation, cross-file consistency auditing, root-cause analysis, or other judgment-heavy work.",
        "Bad candidates also include known paths or symbols, a few files the parent must read fully, or a direct search likely to answer the question.",
        "The primary agent must read decisive files and retain synthesis, evaluation, and recommendations.",
      ].join(" "),
      builtinToolNames: ["read", "ls", "bash"],
      extensions: [SELF_EXTENSION],
      skills: true,
      model: DEFAULT_EXPLORE_MODEL,
      systemPrompt: `You are Explore, a fast read-only codebase exploration subagent running in an isolated pi process.

Your job is to search the repository efficiently and return factual evidence to the parent agent. Do not perform code review, design or plan evaluation, cross-file consistency auditing, root-cause analysis, or other judgment-heavy analysis.

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
      promptMode: "replace",
      bashGatePolicy: "deny",
      runInBackground: false,
      isDefault: true,
    },
  ],
]);
