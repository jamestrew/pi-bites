import { mkdtempSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderExecScanline, renderExecResult } from "./codex-adapter/exec/command-tool.js";
import { Type } from "typebox";

const pending = new Map<string, Promise<void>>();

function indexedRoot(cwd: string): string {
  for (let root = resolve(cwd); ; root = dirname(root)) {
    if (statSync(join(root, ".codegraph"), { throwIfNoEntry: false })?.isDirectory())
      return realpathSync(root);
    if (dirname(root) === root)
      throw new Error(
        "No .codegraph/ index found. Run `codegraph init` in your repository, or use built-in tools.",
      );
  }
}

function boundedOutput(output: string): string {
  const truncated = truncateHead(output);
  if (!truncated.truncated) return output;
  const path = join(mkdtempSync(join(tmpdir(), "pi-codegraph-")), "output.txt");
  writeFileSync(path, output, { mode: 0o600 });
  return `${truncated.content}\n\n[Output truncated. Full output: ${path}]`;
}

const parameters = Type.Object({
  query: Type.String({
    description: "Free-form code question, symbol names, or project-relative paths plus symbols.",
  }),
  maxFiles: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum files to return; omission keeps CodeGraph adaptive behavior.",
    }),
  ),
});

export default async function registerCodegraph(pi: ExtensionAPI): Promise<void> {
  try {
    const result = await pi.exec("codegraph", ["--version"], { timeout: 5000 });
    if (result.code !== 0 || result.killed) return;
  } catch {
    return;
  }
  pi.registerTool<
    typeof parameters,
    { output: string; wall_time_seconds: number },
    { startedAt?: number; endedAt?: number }
  >({
    name: "codegraph_explore",
    label: "codegraph_explore",
    description:
      "Explore indexed code with CodeGraph. Use first for unfamiliar code understanding.",
    promptSnippet:
      "Primary code-understanding tool: explore unfamiliar implementation, behavior, architecture, flows, bugs, and change impact first",
    promptGuidelines: [
      "Use codegraph_explore as the primary code-understanding tool. Call it first for unfamiliar implementation, behavior, architecture, flows, bugs, or change impact; prefer it over manually chaining grep/find/read when the relevant code is not already known.",
      "Treat source returned by codegraph_explore as already read; do not reread it just to acquire context.",
      "Use built-in tools when no .codegraph/ index exists, for non-code surfaces such as Markdown, or for exhaustive file inventories. Do not initialize an index implicitly.",
    ],
    executionMode: "parallel",
    parameters,
    async execute(_id, { query, maxFiles }, signal, _onUpdate, ctx) {
      // Snapshot the session-bound cwd before entering the asynchronous root queue.
      const root = indexedRoot(ctx.cwd);
      const startedAt = Date.now();
      const run = async (args: string[]) => {
        signal?.throwIfAborted();
        const result = await pi.exec("codegraph", args, { cwd: root, signal });
        signal?.throwIfAborted();
        if (result.killed || result.code !== 0)
          throw new Error(
            `CodeGraph failed (${result.code}): ${boundedOutput(result.stderr || result.stdout)}`,
          );
        return result.stdout;
      };
      const task = (pending.get(root) ?? Promise.resolve()).then(async () => {
        await run(["sync", root]);
        const stdout = await run([
          "--no-color",
          "explore",
          "--path",
          root,
          ...(maxFiles === undefined ? [] : ["--max-files", String(maxFiles)]),
          "--",
          query,
        ]);
        const output = boundedOutput(stdout);
        return {
          content: [{ type: "text" as const, text: output }],
          details: { output, wall_time_seconds: (Date.now() - startedAt) / 1000 },
        };
      });
      const settled = task.then(
        () => {},
        () => {},
      );
      pending.set(root, settled);
      void settled.then(() => {
        if (pending.get(root) === settled) pending.delete(root);
      });
      return task;
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) context.state.startedAt ??= Date.now();
      return new Text(
        renderExecScanline(
          "codegraph_explore",
          args.query,
          args.maxFiles === undefined ? "" : ` (max ${args.maxFiles} files)`,
          theme,
        ),
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      return renderExecResult(result, options, theme, context);
    },
  });
}
