/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPLORE_MODEL,
  DEFAULT_EXPLORE_TOOLS,
  EXPLORE_SYSTEM_PROMPT,
} from "../explore/index.js";
import type { AgentConfig } from "./types.js";

// const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

const SELF_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../index${path.extname(fileURLToPath(import.meta.url))}`,
);

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  // [
  //   "general-purpose",
  //   {
  //     name: "general-purpose",
  //     displayName: "Agent",
  //     description: [
  //       "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  //       "When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
  //     ].join(" "),
  //     // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
  //     // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
  //     // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
  //     extensions: true,
  //     skills: true,
  //     systemPrompt: "",
  //     promptMode: "append",
  //     isDefault: true,
  //   },
  // ],
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
      builtinToolNames: [...DEFAULT_EXPLORE_TOOLS],
      extensions: [SELF_EXTENSION],
      skills: true,
      model: DEFAULT_EXPLORE_MODEL,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      promptMode: "replace",
      bashGatePolicy: "deny",
      isDefault: true,
    },
  ],
  // [
  //   "Plan",
  //   {
  //     name: "Plan",
  //     displayName: "Plan",
  //     description: [
  //       "Software architect agent for designing implementation plans.",
  //       "Use this when you need to plan the implementation strategy for a task.",
  //       "Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
  //     ].join(" "),
  //     builtinToolNames: READ_ONLY_TOOLS,
  //     extensions: true,
  //     skills: true,
  //     systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
  // You are a software architect and planning specialist.
  // Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
  // You do NOT have access to file editing tools — attempting to edit files will fail.
  //
  // You are STRICTLY PROHIBITED from:
  // - Creating new files
  // - Modifying existing files
  // - Deleting files
  // - Moving or copying files
  // - Creating temporary files anywhere, including /tmp
  // - Using redirect operators (>, >>, |) or heredocs to write to files
  // - Running ANY commands that change system state
  //
  // # Planning Process
  // 1. Understand requirements
  // 2. Explore thoroughly (read files, find patterns, understand architecture)
  // 3. Design solution based on your assigned perspective
  // 4. Detail the plan with step-by-step implementation strategy
  //
  // # Requirements
  // - Consider trade-offs and architectural decisions
  // - Identify dependencies and sequencing
  // - Anticipate potential challenges
  // - Follow existing patterns where appropriate
  //
  // # Tool Usage
  // - Use the find tool for file pattern matching (NOT the bash find command)
  // - Use the grep tool for content search (NOT bash grep/rg command)
  // - Use the read tool for reading files (NOT bash cat/head/tail)
  // - Use Bash ONLY for read-only operations
  //
  // # Output Format
  // - Use absolute file paths
  // - Do not use emojis
  // - End your response with:
  //
  // ### Critical Files for Implementation
  // List 3-5 files most critical for implementing this plan:
  // - /absolute/path/to/file.ts - [Brief reason]`,
  //     promptMode: "replace",
  //     isDefault: true,
  //   },
  // ],
]);
