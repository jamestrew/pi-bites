import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildDoneStats, type Usage } from "./format/index.js";
import type { SnacksConfig } from "../config.js";

export const DEFAULT_EXPLORE_MODEL = "github-copilot/gpt-5.4-mini";
export const DEFAULT_EXPLORE_TOOLS = ["read", "ls", "bash"] as const;
const DEFAULT_TOOLS = DEFAULT_EXPLORE_TOOLS.join(",");
const SELF_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../index${path.extname(fileURLToPath(import.meta.url))}`,
);
const MAX_VISIBLE_TOOL_CALLS = 3;

type SubagentUsageRecord = {
  type: "subagent_usage";
  subagent: "explore";
  sessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
};

export const EXPLORE_SYSTEM_PROMPT = `You are Explore, a fast read-only codebase exploration subagent running in an isolated pi process.

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
`;

const ExploreParams = Type.Object({
  prompt: Type.String({ description: "What to explore in the codebase" }),
  description: Type.String({
    description:
      "Short title for this explore task shown in the UI (e.g. 'Explore repo structure'). Keep it under 6 words, sentence case.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the explore subprocess. Defaults to cwd — omit unless the user explicitly requests a different directory.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional model override for the explore subprocess" }),
  ),
});

type ExploreDetails = {
  status: "running" | "completed";
  cwd: string;
  model?: string;
  stopReason?: string;
  timeline: string[];
  finalOutput: string;
  usage: Usage;
  startTime: number;
  durationMs?: number;
};

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getSubagentUsageFile(): string {
  return path.join(getAgentDir(), "pi-bites", "usage", "explore.jsonl");
}

function splitProviderModel(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { provider: "unknown", model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

async function appendSubagentUsageRecords(records: SubagentUsageRecord[]): Promise<void> {
  if (records.length === 0) return;

  const file = getSubagentUsageFile();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

export function normalizeToolArg(value: unknown): string {
  return String(value ?? "").trim();
}

export function summarizeToolArg(value: unknown, maxLength = 120): string {
  const singleLine = normalizeToolArg(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}

export function wrapMultilineText(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);

  if (name === "read") {
    const filePath = normalizeToolArg(args.path ?? "?");
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : "?";
      return `${cap}(${filePath}:${start}-${end})`;
    }
    return `${cap}(${filePath})`;
  }

  if (name === "grep") {
    return `${cap}(/${normalizeToolArg(args.pattern)}/ in ${normalizeToolArg(args.path ?? ".")})`;
  }

  if (name === "find") {
    return `${cap}(${normalizeToolArg(args.pattern ?? "*")} in ${normalizeToolArg(args.path ?? ".")})`;
  }

  if (name === "ls") {
    return `${cap}(${normalizeToolArg(args.path ?? ".")})`;
  }

  if (name === "bash") {
    return `${cap}(${normalizeToolArg(args.command)})`;
  }

  return `${cap}(${JSON.stringify(args)})`;
}

function summarizeText(text: string, maxLength = 180): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}

function extractAssistantText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n\n")
    .trim();
}

function buildTimelineFromAssistantMessage(message: any): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];

  const items: string[] = [];
  for (const part of message.content) {
    if (part?.type === "toolCall" && typeof part.name === "string") {
      items.push(`→ ${formatToolCall(part.name, part.arguments ?? {})}`);
    }
    if (part?.type === "text" && typeof part.text === "string") {
      const summary = summarizeText(part.text);
      if (summary) items.push(summary);
    }
  }
  return items;
}

function buildProgressText(timeline: string[], finalOutput: string): string {
  const lines: string[] = [];
  lines.push("Explore subagent running...");

  if (timeline.length > 0) {
    lines.push("");
    lines.push("Recent activity:");
    for (const item of timeline.slice(-8)) {
      const display = item.startsWith("→ ") ? summarizeToolArg(item.slice(2)) : item;
      lines.push(`- ${display}`);
    }
  }

  if (finalOutput.trim()) {
    lines.push("");
    lines.push("Latest answer draft:");
    lines.push(finalOutput.trim());
  }

  return lines.join("\n");
}

function extractTextContent(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n\n")
    .trim();
}

function getBashGateReason(event: any): string | undefined {
  if (event?.type !== "tool_execution_end" || event.toolName !== "bash" || !event.isError) {
    return undefined;
  }

  const text = extractTextContent(event.result?.content);
  if (!text.startsWith("Bash gate:")) return undefined;
  return text;
}

async function writeSystemPromptFile(prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-explore-"));
  const file = path.join(dir, "system-prompt.md");
  await writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

export default function (pi: ExtensionAPI, configRef: { current: SnacksConfig } = { current: {} }) {
  pi.registerTool({
    name: "explore",
    label: "Explore",
    description:
      "Fast read-only codebase reconnaissance in an isolated pi subprocess. Valuable for parallelizing independent queries or protecting the main context window from large search results. Use proactively whenever an investigation spans more than a couple of files, involves tracing behavior across the codebase, or might return large output.\n\nThe `description` parameter is a short UI title for the task. Rules: clear and concise, ideally no more than 6 words, sentence case (capitalize only the first word and proper nouns, not Title Case), avoid jargon unless necessary.\n\nThe `cwd` parameter defaults to the current working directory — leave it null unless the user explicitly requests a different directory.",
    promptSnippet:
      "Use explore for read-only codebase investigation when the task benefits from an isolated subprocess: broad searches across many files, tracing complex behavior, or gathering context before edits. When in doubt about scope, prefer explore — it runs in parallel and keeps the main context clean. Reserve direct tool calls for truly trivial lookups you're already confident about.",
    promptGuidelines: [
      "Explore is valuable for parallelizing independent queries or shielding the main context from large results. Use it proactively for any non-trivial investigation — it runs in parallel and keeps the main context clean. When uncertain about scope, lean toward using explore.",
      "Good candidates: tracing a call chain across many files, understanding a feature end-to-end, finding all usages of a pattern across the codebase, or gathering broad context before a large refactor.",
      "Bad candidates: reading a single already-known file, or a trivial grep you're already confident about — just make those calls directly in the main agent.",
      "In the prompt, give the concrete question plus the desired thoroughness level when helpful, such as quick, medium, or thorough.",
      "Treat the result as findings to verify and synthesize in the parent agent before reporting conclusions or making changes.",
      "Set description to a short, clear title for the task shown in the UI. Keep it under 6 words, sentence case (capitalize only first word and proper nouns).",
    ],
    parameters: ExploreParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const model =
        params.model ?? configRef.current.explore?.defaultModel ?? DEFAULT_EXPLORE_MODEL;
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const usageRecords: SubagentUsageRecord[] = [];
      const exploreSessionId = `explore-${randomUUID()}`;
      const timeline: string[] = [];
      let finalOutput = "";
      let stopReason: string | undefined;
      let stderr = "";

      const promptFile = await writeSystemPromptFile(EXPLORE_SYSTEM_PROMPT);

      const startTime = Date.now();

      const emitUpdate = () => {
        onUpdate?.({
          content: [{ type: "text", text: buildProgressText(timeline, finalOutput) }],
          details: {
            status: "running",
            cwd,
            model,
            stopReason,
            timeline: [...timeline],
            finalOutput,
            usage: { ...usage },
            startTime,
          } satisfies ExploreDetails,
        });
      };

      try {
        const childArgs = [
          "--mode",
          "json",
          "-p",
          "--no-session",
          "-ne",
          "-e",
          SELF_EXTENSION,
          "--no-prompt-templates",
          "--no-themes",
          "--tools",
          configRef.current.explore?.defaultTools ?? DEFAULT_TOOLS,
          "--append-system-prompt",
          promptFile.file,
        ];

        if (model) {
          childArgs.push("--model", model);
        }

        childArgs.push(params.prompt);

        const child = spawn("pi", childArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: { ...process.env, PI_BITES_SUBAGENT: "explore" },
        });

        let aborted = false;
        if (signal) {
          const abortChild = () => {
            aborted = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!child.killed) child.kill("SIGKILL");
            }, 2000);
          };

          if (signal.aborted) abortChild();
          else signal.addEventListener("abort", abortChild, { once: true });
        }

        let buffer = "";

        const handleLine = (line: string) => {
          if (!line.trim()) return;

          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }

          const gateReason = getBashGateReason(event);
          if (gateReason) {
            timeline.push(gateReason);
            emitUpdate();
            return;
          }

          if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = extractAssistantText(event.message);
            if (text) finalOutput = text;

            for (const item of buildTimelineFromAssistantMessage(event.message)) {
              timeline.push(item);
            }

            usage.turns += 1;
            if (event.message?.usage) {
              const input = event.message.usage.input || 0;
              const output = event.message.usage.output || 0;
              const cacheRead = event.message.usage.cacheRead || 0;
              const cacheWrite = event.message.usage.cacheWrite || 0;
              const cost = event.message.usage.cost?.total || 0;
              const fallback = splitProviderModel(model);
              const provider = event.message.provider || fallback.provider;
              const messageModel = event.message.model || fallback.model;
              const timestamp = event.message.timestamp || Date.now();

              usage.input += input;
              usage.output += output;
              usage.cacheRead += cacheRead;
              usage.cacheWrite += cacheWrite;
              usage.cost += cost;

              usageRecords.push({
                type: "subagent_usage",
                subagent: "explore",
                sessionId: exploreSessionId,
                timestamp,
                provider,
                model: messageModel,
                usage: {
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  cost: { total: cost },
                },
              });
            }

            if (event.message?.stopReason) stopReason = event.message.stopReason;
            emitUpdate();
          }
        };

        const exitCode = await new Promise<number>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
          });

          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });

          child.on("error", reject);
          child.on("close", (code) => {
            if (buffer.trim()) handleLine(buffer);
            resolve(code ?? 0);
          });
        });

        if (aborted || stopReason === "aborted") {
          throw new Error("Explore subagent aborted");
        }

        if (exitCode !== 0 || stopReason === "error") {
          throw new Error(stderr.trim() || finalOutput.trim() || "Explore subagent failed");
        }

        await appendSubagentUsageRecords(usageRecords);

        const content = finalOutput.trim() || buildProgressText(timeline, finalOutput);
        return {
          content: [{ type: "text", text: content }],
          details: {
            status: "completed",
            cwd,
            model,
            stopReason,
            timeline,
            finalOutput,
            usage,
            startTime,
            durationMs: Date.now() - startTime,
          } satisfies ExploreDetails,
        };
      } finally {
        await unlink(promptFile.file).catch(() => undefined);
        await rm(promptFile.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    renderCall(args, theme) {
      const preview = args.description || summarizeText(args.prompt ?? "", 80) || "no prompt";
      const selectedModel =
        args.model ?? configRef.current.explore?.defaultModel ?? DEFAULT_EXPLORE_MODEL;
      const { provider, model } = splitProviderModel(selectedModel);
      const modelSuffix = theme.fg("dim", `: ${provider}/${model}`);
      const cwdSuffix = args.cwd ? theme.fg("dim", `: [${args.cwd}]`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("Explore")) +
          theme.fg("dim", `(${preview})`) +
          modelSuffix +
          cwdSuffix,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      const details = result.details as ExploreDetails | undefined;
      const timeline = details?.timeline ?? [];
      const usage = details?.usage ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
        contextTokens: 0,
      };

      // Only tool call entries are prefixed with "→ "
      const toolCalls = timeline
        .filter((item) => item.startsWith("→ "))
        .map((item) => item.slice(2));

      const prefix0 = theme.fg("dim", "⎿  ");
      const indent = "   ";
      const INDENT_WIDTH = 3; // visible columns used by prefix0 / indent

      return {
        render(width: number): string[] {
          const callWidth = Math.max(1, width - INDENT_WIDTH);
          const lines: string[] = [];

          if (options.expanded) {
            // Prompt
            const prompt = (context.args.prompt ?? "").trim();
            if (prompt) {
              lines.push(theme.fg("muted", "Prompt:"));
              for (const l of wrapTextWithAnsi(prompt, callWidth)) {
                lines.push(theme.fg("dim", l));
              }
              lines.push("");
            }

            // Tool calls
            for (const call of toolCalls) {
              for (const line of wrapMultilineText(call, callWidth)) {
                lines.push(theme.fg("dim", line));
              }
            }

            // Final output
            const output = details?.finalOutput?.trim() ?? "";
            if (output) {
              lines.push("");
              for (const l of wrapTextWithAnsi(output, callWidth)) {
                lines.push(l);
              }
            }

            lines.push("");
            if (options.isPartial) {
              lines.push(theme.fg("muted", "Running\u2026"));
            } else {
              const stats = buildDoneStats(toolCalls.length, usage, details?.durationMs);
              lines.push(theme.fg("success", "Done") + theme.fg("muted", ` (${stats})`));
            }
          } else if (options.isPartial) {
            const hiddenCount = Math.max(0, toolCalls.length - MAX_VISIBLE_TOOL_CALLS);
            const visibleCalls = toolCalls.slice(-MAX_VISIBLE_TOOL_CALLS);
            for (const call of visibleCalls) {
              lines.push(
                truncateToWidth(theme.fg("dim", summarizeToolArg(call)), callWidth, "\u2026"),
              );
            }
            lines.push(theme.fg("muted", "Running\u2026"));
            if (hiddenCount > 0) {
              lines.push(theme.fg("muted", `+${hiddenCount} more tool uses (ctrl+o to expand)`));
            }
          } else {
            const stats = buildDoneStats(toolCalls.length, usage, details?.durationMs);
            lines.push(theme.fg("success", "Done") + theme.fg("muted", ` (${stats})`));
            if (toolCalls.length > 0) {
              lines.push(theme.fg("muted", "(ctrl+o to expand)"));
            }
          }

          return lines.map((l, i) => (i === 0 ? prefix0 + l : indent + l));
        },
        invalidate() {},
      };
    },
  });
}
