import {
  type AgentToolResult,
  type ExtensionAPI,
  type ReadToolDetails,
  createReadTool,
  createReadToolDefinition,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
} from "@earendil-works/pi-coding-agent";

const readDescriptionSuffix = [
  "Successful text-file results use cat -n format with source line numbers.",
  "Call this tool in parallel when you know there are multiple files you want to read.",
  "Avoid tiny repeated slices (30 line chunks).",
  "If you need more context, read a larger window.",
].join(" ");

const readNoticePattern =
  /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/;

function numberReadText(text: string, startLine: number, expectedLines?: number): string {
  if (!text && expectedLines !== 1) return text;

  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  const trailingNewlineEndsContent =
    hasTrailingNewline && lines.length > (expectedLines ?? lines.length - 1);
  if (trailingNewlineEndsContent) lines.pop();

  const numbered = lines
    .map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`)
    .join("\n");
  return trailingNewlineEndsContent ? `${numbered}\n` : numbered;
}

function stripReadExpandHint<T extends { render(width: number): string[] }>(component: T): T {
  const originalRender = component.render.bind(component);
  component.render = (width: number) =>
    originalRender(width).map((line) => line.replace(/,\s+\S*ctrl\+o\S*\s+to expand\)/i, ")"));
  return component;
}

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
  const originalReadDef = createReadToolDefinition(cwd);
  const originalBash = createBashTool(cwd);
  const originalBashDef = createBashToolDefinition(cwd);
  const originalEdit = createEditTool(cwd);
  const renderReadResult = originalReadDef.renderResult;
  const renderBashCall = originalBashDef.renderCall;
  if (!renderReadResult || !renderBashCall) throw new Error("Built-in tool renderers unavailable");

  pi.registerTool({
    ...originalRead,
    description: `${originalRead.description} ${readDescriptionSuffix}`,

    async execute(toolCallId, params, signal, onUpdate) {
      const result = (await originalRead.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      )) as AgentToolResult<ReadToolDetails | undefined>;
      if (
        result.details?.truncation?.firstLineExceedsLimit ||
        result.content.some((content) => content.type === "image") ||
        result.content.some(
          (content) => content.type === "text" && content.text.startsWith("Read image file ["),
        )
      ) {
        return result;
      }

      const noticeMatch =
        (params.limit !== undefined || result.details?.truncation?.truncated) &&
        result.content[0]?.type === "text"
          ? result.content[0].text.match(readNoticePattern)
          : null;

      const expectedLines =
        result.details?.truncation?.outputLines ?? (noticeMatch ? params.limit : undefined);

      return {
        ...result,
        content: result.content.map((content) => {
          if (content.type !== "text") return content;
          const notice = noticeMatch?.[0] ?? "";
          const fileText = notice ? content.text.slice(0, -notice.length) : content.text;
          return {
            ...content,
            text: `${numberReadText(fileText, Math.max(1, params.offset ?? 1), expectedLines)}${notice}`,
          };
        }),
      };
    },

    renderResult(result, options, theme, context) {
      return stripReadExpandHint(
        renderReadResult(
          result as AgentToolResult<ReadToolDetails | undefined>,
          { ...options, expanded: false },
          theme,
          context,
        ),
      );
    },
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
      return renderBashCall(args, theme, {
        ...context,
        executionStarted: executeStartTimes.has(context.toolCallId),
      });
    },
  });
}
