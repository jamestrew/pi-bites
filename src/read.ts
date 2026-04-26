import * as path from "node:path";
import {
  type ExtensionAPI,
  type ReadToolDetails,
  createReadTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadTool(cwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: originalRead.description,
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalRead.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("read")), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const args = context.args as { path: string; offset?: number; limit?: number };
      const displayPath =
        args.path.startsWith(cwd + path.sep) || args.path === cwd
          ? path.relative(cwd, args.path)
          : args.path;

      const pathText = theme.fg("accent", displayPath);

      const paramParts: string[] = [];
      if (args.offset) paramParts.push(`offset=${args.offset}`);
      if (args.limit) paramParts.push(`limit=${args.limit}`);
      const paramText = paramParts.length > 0 ? theme.fg("dim", ` (${paramParts.join(", ")})`) : "";

      if (isPartial) {
        return new Text(`${pathText}${paramText}  ${theme.fg("warning", "Reading...")}`, 0, 0);
      }

      const details = result.details as ReadToolDetails | undefined;
      const content = result.content[0];

      if (content?.type === "image") {
        return new Text(`${pathText}  ${theme.fg("success", "image")}`, 0, 0);
      }

      if (content?.type !== "text") {
        return new Text(`${pathText}  ${theme.fg("error", "no content")}`, 0, 0);
      }

      const lineCount = content.text.split("\n").length;
      let lineText = theme.fg("success", `${lineCount} lines`);

      if (details?.truncation?.truncated) {
        lineText += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
      }

      let text = `${pathText}${paramText}  ${lineText}`;

      if (expanded) {
        const lines = content.text.split("\n").slice(0, 15);
        for (const line of lines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 15) {
          text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
