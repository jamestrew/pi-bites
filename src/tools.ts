import * as path from "node:path";
import {
  type ExtensionAPI,
  createReadTool,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const shortenPath = (p: string, cwd: string): string => {
  return p.startsWith(cwd + path.sep) || p === cwd ? path.relative(cwd, p) : p;
};

const readDescriptionSuffix = [
  "Call this tool in parallel when you know there are multiple files you want to read.",
  "Avoid tiny repeated slices (30 line chunks).",
  "If you need more context, read a larger window.",
].join(" ");

const editDescription = [
  "Edit a single existing file using exact-first text replacement.",
  "Each edits[].oldText must identify one unique, non-overlapping region of the original file.",
  "All edits are matched against the original file, not incrementally.",
  "When copying from read output, use only the actual file text: never include line numbers or prefixes, and preserve indentation exactly, including tabs vs spaces.",
  "Prefer the smallest stable unique snippet rather than a large copied block, and merge nearby changes into one edit instead of emitting overlapping edits.",
].join(" ");

const editPromptSnippet = [
  "Make precise file edits with exact-first text replacement,",
  "using small unique anchors and preserving exact indentation from read output",
].join(" ");

const editPromptGuidelines = [
  "Use edit for precise changes to existing files; use write only for new files or complete rewrites.",
  "When copying from read output, use only the actual file text. Never include line numbers or prefixes in oldText or newText.",
  "Preserve indentation exactly, including tabs vs spaces.",
  "Each edits[].oldText should be as small as possible while still being unique in the file.",
  "Prefer a small stable anchor over a large copied block. Do not pad oldText with large unchanged regions.",
  "All edits are matched against the original file contents, not after earlier edits in the same call.",
  "Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "For repeated rename-style changes in one file, prefer one deliberate multi-edit strategy rather than many ad hoc replacements.",
];

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadTool(cwd);
  const originalBash = createBashTool(cwd);
  const originalBashDef = createBashToolDefinition(cwd);
  const originalEdit = createEditTool(cwd);

  pi.registerTool({
    ...originalRead,
    description: `${originalRead.description} ${readDescriptionSuffix}`,

    // async execute(toolCallId, params, signal, onUpdate) {
    //   return originalRead.execute(toolCallId, params, signal, onUpdate);
    // },

    // renderCall(args, theme, _context) {
    //   const p = shortenPath(args.path || "", cwd);
    //   let pathDisplay = p ? theme.fg("accent", p) : theme.fg("toolOutput", "...");

    //   // Show line range if specified
    //   if (args.offset !== undefined || args.limit !== undefined) {
    //     const startLine = args.offset ?? 1;
    //     const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
    //     pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
    //   }

    //   return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
    // },

    // renderResult(result, { expanded }, theme, _context) {
    //   // Minimal mode: show nothing in collapsed state
    //   if (!expanded) {
    //     return new Text("", 0, 0);
    //   }

    //   // Expanded mode: show full output
    //   const textContent = result.content.find((c) => c.type === "text");
    //   if (!textContent || textContent.type !== "text") {
    //     return new Text("", 0, 0);
    //   }

    //   const lines = textContent.text.split("\n");
    //   const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
    //   return new Text(`\n${output}`, 0, 0);
    // },
  });

  pi.registerTool({
    ...originalEdit,
    description: editDescription,
    promptSnippet: editPromptSnippet,
    promptGuidelines: editPromptGuidelines,
  });

  // Track the moment execute() is actually called (i.e. after bash-gate approval).
  // Keyed by toolCallId so concurrent calls don't collide.
  const executeStartTimes = new Map<string, number>();

  pi.registerTool({
    ...originalBash,

    async execute(toolCallId, params, signal, onUpdate) {
      // Record now — this runs after bash-gate resolves, so the elapsed timer
      // will start from the moment the process is actually about to spawn.
      executeStartTimes.set(toolCallId, Date.now());
      try {
        return await originalBash.execute(toolCallId, params, signal, onUpdate);
      } finally {
        executeStartTimes.delete(toolCallId);
      }
    },

    renderCall(args, theme, context) {
      // The TUI sets context.executionStarted at `tool_execution_start`, which
      // fires before bash-gate runs. Override it so the elapsed timer only
      // starts when execute() is actually called (post-gate).
      return originalBashDef.renderCall!(args, theme, {
        ...context,
        executionStarted: executeStartTimes.has(context.toolCallId),
      });
    },
  });
}
