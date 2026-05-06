import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { type ExtensionAPI, createReadTool, createBashTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

function isAvailable(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const shortenPath = (p: string, cwd: string): string => {
  return p.startsWith(cwd + path.sep) || p === cwd ? path.relative(cwd, p) : p;
};

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadTool(cwd);
  const originalBash = createBashTool(cwd);

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

  const hasFd = isAvailable("fd");
  const hasRg = isAvailable("rg");

  const bashExtra: string[] = [
    "Read files: use the read tool, NOT cat/head/tail/sed.",
    "Avoid broad filesystem searches like `find /` or `find .` from the repo root — always scope file searches to a specific subdirectory.",
  ];
  if (hasFd) bashExtra.push("Prefer `fd` over `find` for file search.");
  if (hasRg) bashExtra.push("Prefer `rg` over `grep` for content search.");

  pi.registerTool({
    ...originalBash,
    description: originalBash.description + " " + bashExtra.join(" "),
  });
}
