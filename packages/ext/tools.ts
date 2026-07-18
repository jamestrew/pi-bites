import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentToolResult,
  type EditToolDetails,
  type EditToolInput,
  type ExtensionAPI,
  type ReadToolDetails,
  createReadTool,
  createReadToolDefinition,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { normalizeLineEndings, planEdit } from "./edit-planner.js";

const readDescriptionSuffix = [
  "Call this tool in parallel when you know there are multiple files you want to read.",
  "Avoid tiny repeated slices (30 line chunks).",
  "If you need more context, read a larger window.",
].join(" ");

function stripReadExpandHint<T extends { render(width: number): string[] }>(component: T): T {
  const originalRender = component.render.bind(component);
  component.render = (width: number) =>
    originalRender(width).map((line) => line.replace(/,\s+\S*ctrl\+o\S*\s+to expand\)/i, ")"));
  return component;
}

const editDescription = [
  "Edit one exact string in an existing file.",
  "By default old_string must identify exactly one match; set replace_all only to replace every match intentionally.",
  "Matching is exact first, then tolerates trailing whitespace and common Unicode punctuation, then per-line indentation differences.",
  "Read the file first and copy its text without line-number prefixes, preserving whitespace and indentation.",
].join(" ");

const editPromptSnippet =
  "Replace one exact string in an existing file, with optional intentional replace_all";

const editPromptGuidelines = [
  "Read a target file before using edit, and copy old_string from the current file without line-number prefixes.",
  "Use edit for narrow changes to existing files; use write only for new files or complete rewrites.",
  "Preserve exact whitespace and indentation in old_string and new_string, including tabs versus spaces.",
  "Use edit replace_all only when every occurrence should change; otherwise include enough context for one unique match.",
];

const editParameters = Type.Object({
  path: Type.String({ description: "Path to the existing file (relative or absolute)" }),
  old_string: Type.String({
    description: "Text to replace; must be unique unless replace_all is true",
  }),
  new_string: Type.String({ description: "Replacement text" }),
  replace_all: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Replace every match at the first successful matching tier",
    }),
  ),
});

type EditInput = Static<typeof editParameters>;
type EditRenderAdapterState = {
  adapterArgs?: EditToolInput;
  adapterKey?: string;
  adapterPending?: boolean;
};

const editQueues = new Map<string, Promise<void>>();

async function serializeEdit<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = editQueues.get(path) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  const queued = previous.then(() => gate);
  editQueues.set(path, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (editQueues.get(path) === queued) editQueues.delete(path);
  }
}

async function prepareEdit(cwd: string, input: EditInput, writable: boolean) {
  const filePath = input.path.startsWith("@") ? input.path.slice(1) : input.path;
  const absolutePath = resolve(cwd, filePath);
  try {
    await access(absolutePath, writable ? constants.R_OK | constants.W_OK : constants.R_OK);
    const raw = (await readFile(absolutePath)).toString("utf8");
    const content = normalizeLineEndings(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
    return {
      filePath,
      absolutePath,
      plan: planEdit(
        content,
        normalizeLineEndings(input.old_string),
        normalizeLineEndings(input.new_string),
        input.replace_all ?? false,
        input.path,
      ),
    };
  } catch (error) {
    if (error instanceof Error && !Reflect.has(error, "code")) throw error;
    const code =
      error instanceof Error && Reflect.has(error, "code")
        ? ` Error code: ${Reflect.get(error, "code")}.`
        : "";
    throw new Error(`Could not edit file: ${input.path}.${code}`);
  }
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadTool(cwd);
  const originalReadDef = createReadToolDefinition(cwd);
  const originalBash = createBashTool(cwd);
  const originalBashDef = createBashToolDefinition(cwd);
  const originalEdit = createEditTool(cwd);
  const { prepareArguments: _builtInPrepareArguments, ...editToolBase } = originalEdit;
  void _builtInPrepareArguments;
  const originalEditDef = createEditToolDefinition(cwd);
  const renderReadResult = originalReadDef.renderResult;
  const renderBashCall = originalBashDef.renderCall;
  const renderEditCall = originalEditDef.renderCall;
  const renderEditResult = originalEditDef.renderResult;
  if (!renderReadResult || !renderBashCall || !renderEditCall || !renderEditResult)
    throw new Error("Built-in tool renderers unavailable");

  pi.registerTool({
    ...originalRead,
    description: `${originalRead.description} ${readDescriptionSuffix}`,

    renderResult(result: AgentToolResult<ReadToolDetails | undefined>, options, theme, context) {
      return stripReadExpandHint(
        renderReadResult(result, { ...options, expanded: false }, theme, context),
      );
    },
  });

  pi.registerTool({
    ...editToolBase,
    description: editDescription,
    promptSnippet: editPromptSnippet,
    promptGuidelines: editPromptGuidelines,
    parameters: editParameters,
    renderShell: originalEditDef.renderShell,

    renderCall(args, theme, context) {
      const state = context.state as EditRenderAdapterState;
      const adapterKey = JSON.stringify(args);
      if (state.adapterKey !== adapterKey) {
        state.adapterKey = adapterKey;
        state.adapterArgs = undefined;
        state.adapterPending = false;
      }

      if (context.argsComplete && !state.adapterArgs && !state.adapterPending) {
        state.adapterPending = true;
        void prepareEdit(cwd, args, false)
          .then(({ filePath, plan }) => {
            if (state.adapterKey === adapterKey) {
              state.adapterArgs = {
                path: filePath,
                edits: [{ oldText: plan.content, newText: plan.nextContent }],
              };
            }
          })
          .catch(() => {
            if (state.adapterKey === adapterKey) {
              state.adapterArgs = {
                path: args.path,
                edits: [{ oldText: args.old_string, newText: args.new_string }],
              };
            }
          })
          .finally(() => {
            if (state.adapterKey === adapterKey) {
              state.adapterPending = false;
              context.invalidate();
            }
          });
      }

      const rendererArgs = state.adapterArgs ?? { path: args.path };
      return renderEditCall(rendererArgs as Parameters<typeof renderEditCall>[0], theme, {
        ...context,
        args: rendererArgs,
      } as Parameters<typeof renderEditCall>[2]);
    },

    renderResult(result, options, theme, context) {
      return renderEditResult(
        result as Parameters<typeof renderEditResult>[0],
        options,
        theme,
        context as unknown as Parameters<typeof renderEditResult>[3],
      );
    },

    async execute(toolCallId, params, signal, onUpdate) {
      const unresolvedPath = resolve(
        cwd,
        params.path.startsWith("@") ? params.path.slice(1) : params.path,
      );
      const queuePath = await realpath(unresolvedPath).catch(() => unresolvedPath);

      return serializeEdit(queuePath, async () => {
        const { filePath, plan } = await prepareEdit(cwd, params, true);
        const guardedEdit = createEditTool(cwd, {
          operations: {
            access: (path) => access(path, constants.R_OK | constants.W_OK),
            async readFile(path) {
              const buffer = await readFile(path);
              const raw = buffer.toString("utf8");
              const current = normalizeLineEndings(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
              if (current !== plan.content) {
                throw new Error(
                  `Could not edit ${params.path}: the file changed; reread it and try again.`,
                );
              }
              return buffer;
            },
            writeFile: (path, content) => writeFile(path, content, "utf8"),
          },
        });
        const result = await guardedEdit.execute(
          toolCallId,
          {
            path: filePath,
            edits: [{ oldText: plan.content, newText: plan.nextContent }],
          },
          signal,
          onUpdate,
        );
        const fuzzyNotice = plan.matchTier === "exact" ? "" : ` Used ${plan.matchTier} matching.`;
        const details = result.details as EditToolDetails | undefined;
        return {
          ...result,
          content: [
            {
              type: "text",
              text: `Successfully replaced ${plan.replacementCount} occurrence(s) in ${params.path}.${fuzzyNotice}`,
            },
          ],
          details: details && { ...details, matchTier: plan.matchTier },
        };
      });
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
      return renderBashCall(args, theme, {
        ...context,
        executionStarted: executeStartTimes.has(context.toolCallId),
      });
    },
  });
}
