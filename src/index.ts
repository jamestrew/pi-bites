import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_TOOLS = "read,grep,find,ls";

const EXPLORE_SYSTEM_PROMPT = `You are an exploration subagent running in an isolated pi process.

Your job is to investigate the codebase efficiently and return useful findings to the parent agent.

Rules:
- You are read-only. Do not modify files.
- Prefer grep/find/ls to locate code before reading files.
- Read only the relevant sections of files, not entire large files unless necessary.
- Be concrete: include exact file paths and line ranges when useful.
- Assume your output will be consumed by another agent or by the user without additional context.

Output format:

## Summary
A short answer to the task.

## Findings
- Key point with exact file path(s)
- Important behavior, types, or dependencies
- Anything surprising or risky

## Files to Inspect Next
- path/to/file.ts - why it matters

## Notes
Any caveats, open questions, or follow-up suggestions.
`;

const ExploreParams = Type.Object({
  task: Type.String({ description: "What to explore in the codebase" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the explore subprocess" })),
  model: Type.Optional(
    Type.String({ description: "Optional model override for the explore subprocess" }),
  ),
});

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

type ExploreDetails = {
  status: "running" | "completed";
  cwd: string;
  model?: string;
  stopReason?: string;
  timeline: string[];
  finalOutput: string;
  usage: Usage;
};

function formatToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "read") {
    const filePath = String(args.path ?? "?");
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : "?";
      return `read ${filePath}:${start}-${end}`;
    }
    return `read ${filePath}`;
  }

  if (name === "grep") {
    return `grep /${String(args.pattern ?? "")}/ in ${String(args.path ?? ".")}`;
  }

  if (name === "find") {
    return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
  }

  if (name === "ls") {
    return `ls ${String(args.path ?? ".")}`;
  }

  const raw = JSON.stringify(args);
  return `${name} ${raw.length > 80 ? `${raw.slice(0, 80)}...` : raw}`;
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
    for (const item of timeline.slice(-8)) lines.push(`- ${item}`);
  }

  if (finalOutput.trim()) {
    lines.push("");
    lines.push("Latest answer draft:");
    lines.push(finalOutput.trim());
  }

  return lines.join("\n");
}

async function writeSystemPromptFile(prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-explore-"));
  const file = path.join(dir, "system-prompt.md");
  await writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "explore",
    label: "Explore",
    description:
      "Explore the codebase in an isolated read-only pi subprocess and report findings back.",
    promptSnippet:
      "Explore the codebase in an isolated read-only subprocess when reconnaissance or codebase investigation would help.",
    promptGuidelines: [
      "Use explore for reconnaissance, tracing code paths, locating relevant files, or gathering context before editing.",
      "Prefer explore when you want a separate context window to inspect the repo without cluttering the main thread.",
    ],
    parameters: ExploreParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model ?? activeModel;
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const timeline: string[] = [];
      let finalOutput = "";
      let stopReason: string | undefined;
      let stderr = "";

      const promptFile = await writeSystemPromptFile(EXPLORE_SYSTEM_PROMPT);

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
          } satisfies ExploreDetails,
        });
      };

      try {
        const childArgs = [
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--tools",
          DEFAULT_TOOLS,
          "--append-system-prompt",
          promptFile.file,
        ];

        if (model) {
          childArgs.push("--model", model);
        }

        childArgs.push(params.task);

        const child = spawn("pi", childArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
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

          if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = extractAssistantText(event.message);
            if (text) finalOutput = text;

            for (const item of buildTimelineFromAssistantMessage(event.message)) {
              timeline.push(item);
            }

            usage.turns += 1;
            if (event.message?.usage) {
              usage.input += event.message.usage.input || 0;
              usage.output += event.message.usage.output || 0;
              usage.cacheRead += event.message.usage.cacheRead || 0;
              usage.cacheWrite += event.message.usage.cacheWrite || 0;
              usage.cost += event.message.usage.cost?.total || 0;
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
          } satisfies ExploreDetails,
        };
      } finally {
        await unlink(promptFile.file).catch(() => undefined);
        await rm(promptFile.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    renderCall(args, theme) {
      const preview = summarizeText(args.task ?? "", 100) || "(no task)";
      const cwdText = args.cwd ? `\n${theme.fg("muted", `cwd: ${args.cwd}`)}` : "";
      const modelText = args.model ? `\n${theme.fg("muted", `model: ${args.model}`)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("explore ")) +
          theme.fg("dim", preview) +
          cwdText +
          modelText,
        0,
        0,
      );
    },
  });
}
