import * as path from "node:path";
import {
  type ExtensionAPI,
  createReadTool,
  createBashTool,
  createBashToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const shortenPath = (p: string, cwd: string): string => {
  return p.startsWith(cwd + path.sep) || p === cwd ? path.relative(cwd, p) : p;
};

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadTool(cwd);
  const originalBash = createBashTool(cwd);
  const originalBashDef = createBashToolDefinition(cwd);

  pi.registerTool({
    name: "read",
    label: "read",
    description:
      originalRead.description +
      " Call this tool in parallel when you know there are multiple files you want to read. Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalRead.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, _context) {
      const p = shortenPath(args.path || "", cwd);
      let pathDisplay = p ? theme.fg("accent", p) : theme.fg("toolOutput", "...");

      // Show line range if specified
      if (args.offset !== undefined || args.limit !== undefined) {
        const startLine = args.offset ?? 1;
        const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
        pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }

      return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      // Minimal mode: show nothing in collapsed state
      if (!expanded) {
        return new Text("", 0, 0);
      }

      // Expanded mode: show full output
      const textContent = result.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        return new Text("", 0, 0);
      }

      const lines = textContent.text.split("\n");
      const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
      return new Text(`\n${output}`, 0, 0);
    },
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
