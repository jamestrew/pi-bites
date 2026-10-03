import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  keyHint,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type CodemodeToolDetails,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sanitizeText } from "../subagents/ui/text-lines.js";
import { renderExecResult } from "./exec/command-tool.js";
import type { UnifiedExecResult } from "./exec/session-manager.js";

type Context = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
type Renderer = Pick<ToolDefinition, "renderCall" | "renderResult">;
interface DisplayCall {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "completed" | "error" | "interrupted";
  startedAt: number;
  durationMs?: number;
  result?: AgentToolResult<unknown>;
}
interface DisplayDetails extends CodemodeToolDetails {
  display?: { cwd: string; calls: DisplayCall[]; omitted: number };
}
interface Scope {
  cwd: string;
  calls: Map<string, DisplayCall>;
  omitted: number;
  latest: AgentToolResult<DisplayDetails>;
  publish?: AgentToolUpdateCallback<DisplayDetails>;
}

// Presentation retains at most 128 calls and 1 MiB per script. Increase these only
// if real transcripts need larger previews; model output budgets remain Pi's responsibility.
const MAX_CALLS = 128;
const MAX_BYTES = 1024 * 1024;
// eslint-disable-next-line no-control-regex -- preserve only trusted diff color sequences.
const SGR = /(\u001b\[[\d;]*m)/;
const HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** Bound JSON display data, excluding image/structured payloads. Only SGR colors survive
 * in patch previews; terminal controls in all other strings are removed. */
function bounded(value: unknown): unknown {
  let remaining = 32 * 1024;
  let nodes = 2048;
  const visit = (item: unknown, depth: number, keepColors: boolean): unknown => {
    if (--nodes < 0 || depth > 10) return undefined;
    if (typeof item === "string") {
      const clean = keepColors
        ? item
            .split(SGR)
            .map((s, i) => (i % 2 ? s : sanitizeText(s)))
            .join("")
        : sanitizeText(item);
      const limit = Math.max(0, Math.min(8192, remaining));
      remaining -= Math.min(clean.length, limit);
      return clean.length <= limit ? clean : `${clean.slice(0, limit)}\n[Display truncated]`;
    }
    if (Array.isArray(item)) return item.slice(0, 128).map((v) => visit(v, depth + 1, keepColors));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .slice(0, 64)
          .map(([key, v]) => [
            sanitizeText(key).slice(0, 128),
            visit(v, depth + 1, keepColors || key === "render"),
          ]),
      );
    return typeof item === "number" || typeof item === "boolean" || item === null
      ? item
      : undefined;
  };
  return visit(value, 0, false);
}

/** Decorates presentation only: Pi still executes tools, hooks and accounting exactly once. */
export function createNativeRendering(pi: ExtensionAPI, owned: Record<string, Renderer>) {
  const scopes = new Map<string, Scope>();
  const renderers = new Map(Object.entries(owned));
  function attach(scope: Scope, result: AgentToolResult<DisplayDetails | undefined>) {
    return {
      ...result,
      details: {
        ...(result.details ?? scope.latest.details),
        display: { cwd: scope.cwd, calls: [...scope.calls.values()], omitted: scope.omitted },
      },
    };
  }
  function publish(scope: Scope) {
    // UI callbacks must never turn successful tool execution into a tool failure.
    try {
      scope.publish?.(attach(scope, scope.latest));
    } catch {
      /* Detached display. */
    }
  }
  function capture(parent: string | undefined, update: (scope: Scope) => void) {
    if (!parent) return;
    const scope = scopes.get(parent);
    if (!scope) return;
    update(scope);
    while (
      scope.calls.size > MAX_CALLS ||
      Buffer.byteLength(JSON.stringify([...scope.calls.values()])) > MAX_BYTES
    ) {
      const first = scope.calls.keys().next().value;
      if (first === undefined) break;
      scope.calls.delete(first);
      scope.omitted++;
    }
    publish(scope);
  }
  pi.on("tool_execution_start", (event) =>
    capture(event.parentToolCallId, (scope) => {
      scope.calls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: bounded(event.args),
        status: "running",
        startedAt: Date.now(),
      });
    }),
  );
  pi.on("tool_call", (event) =>
    capture(event.parentToolCallId, (scope) => {
      const call = scope.calls.get(event.toolCallId);
      if (call) scope.calls.set(call.id, { ...call, args: bounded(event.input) });
    }),
  );
  pi.on("tool_execution_update", (event) =>
    capture(event.parentToolCallId, (scope) => {
      const call = scope.calls.get(event.toolCallId);
      if (call && renderers.has(call.name))
        scope.calls.set(call.id, {
          ...call,
          result: displayResult(event.partialResult as AgentToolResult<unknown>),
        });
    }),
  );
  pi.on("tool_execution_end", (event) =>
    capture(event.parentToolCallId, (scope) => {
      const call = scope.calls.get(event.toolCallId);
      if (!call) return;
      scope.calls.set(call.id, {
        ...call,
        status: event.isError ? "error" : "completed",
        durationMs: Date.now() - call.startedAt,
        // Unrelated tools keep metadata-only presentation; do not retain arbitrary payloads.
        result:
          renderers.has(call.name) || event.isError
            ? displayResult(event.result as AgentToolResult<unknown>, renderers.has(call.name))
            : undefined,
      });
    }),
  );
  pi.on("tool_result", (event) => {
    // Later hooks may change prepared arguments. Retain what actually executed,
    // rather than the raw sandbox input or our earlier preparation observation.
    capture(event.parentToolCallId, (scope) => {
      const call = scope.calls.get(event.toolCallId);
      if (call) scope.calls.set(call.id, { ...call, args: bounded(event.input) });
    });
    if (event.toolName !== "codemode") return;
    const scope = scopes.get(event.toolCallId);
    if (!scope) return;
    scope.publish = undefined;
    scopes.delete(event.toolCallId);
    for (const [id, call] of scope.calls)
      if (call.status === "running") scope.calls.set(id, { ...call, status: "interrupted" });
    return {
      details: attach(scope, {
        content: event.content,
        details: event.details as DisplayDetails | undefined,
      }).details,
    };
  });
  const reset = () => {
    for (const scope of scopes.values()) scope.publish = undefined;
    scopes.clear();
  };
  return {
    reset,
    decorate(tool: ToolDefinition): ToolDefinition {
      const nativeRenderResult = tool.renderResult;
      if (tool.name !== "codemode" || !nativeRenderResult) return tool;
      return {
        ...tool,
        async execute(id, args, signal, onUpdate, ctx) {
          const scope: Scope = {
            cwd: ctx.cwd,
            calls: new Map(),
            omitted: 0,
            latest: { content: [], details: { calls: [] } },
            publish: onUpdate,
          };
          scopes.set(id, scope);
          try {
            const result = await tool.execute(
              id,
              args,
              signal,
              (partial) => {
                scope.latest = partial as AgentToolResult<DisplayDetails>;
                if (scopes.get(id) === scope) publish(scope);
              },
              ctx,
            );
            return result;
          } finally {
            scope.publish = undefined;
            // Keep snapshots until the parent result hook, including unexpected native errors.
          }
        },
        renderResult(result, options, theme, context) {
          const data = result.details as DisplayDetails | undefined;
          // Pi mutates its Text cache. Never pass the hybrid component as that cache,
          // or share one Text between the separate output and error delegations.
          if (!data?.display)
            return nativeRenderResult(result, options, theme, {
              ...context,
              lastComponent: undefined,
            });
          const body = new Container();
          const retained = data.display.calls;
          const calls = options.expanded ? retained : retained.slice(-8);
          for (const [index, call] of calls.entries()) {
            if (index) body.addChild(new Text(" ", 0, 0));
            body.addChild(
              renderCall(call, renderers.get(call.name), theme, {
                ...context,
                cwd: data.display.cwd,
              }),
            );
          }
          // Execution metadata may retain calls whose larger display snapshots were evicted.
          if (data.display.omitted)
            body.addChild(
              new Text(
                theme.fg("dim", `[${data.display.omitted} earlier display snapshots omitted]`),
                0,
                0,
              ),
            );
          const output = result.content.filter(
            (part, i) => !(i === 0 && part.type === "text" && HEADER.test(part.text)),
          );
          if (output.length) {
            const tokens = Math.ceil(
              output
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n").length / 4,
            );
            body.addChild(
              new Text(
                `\n${theme.bold("Output")}${tokens ? theme.fg("accent", ` ~${tokens.toLocaleString("en-US")} input tokens`) : ""}`,
                0,
                0,
              ),
            );
            // Keep native output truncation, full-output links and image fallback. Pi renders
            // actual images independently from the unchanged original result.content.
            const errors = options.expanded
              ? []
              : output.filter(
                  (part) => part.type === "text" && part.text.startsWith("Script error:\n"),
                );
            const outputResult = {
              ...result,
              content: result.content.filter((part) => !errors.includes(part)),
              details: { ...data, calls: [] },
            };
            const nativeOutput = nativeRenderResult(
              outputResult,
              { ...options, expanded: true },
              theme,
              { ...context, lastComponent: undefined },
            );
            const nativeErrors = errors.length
              ? nativeRenderResult(
                  { ...outputResult, content: errors },
                  { ...options, expanded: true },
                  theme,
                  { ...context, lastComponent: undefined },
                )
              : undefined;
            body.addChild({
              render(width) {
                const lines = nativeOutput.render(width);
                const errorLines = nativeErrors?.render(width) ?? [];
                const visible = options.expanded ? lines : lines.slice(0, 9);
                const visibleErrors = options.expanded ? errorLines : errorLines.slice(0, 9);
                const rendered = [...visible, ...visibleErrors];
                if (!options.expanded && data.fullOutputPath)
                  rendered.push(
                    ...new Text(
                      theme.fg("dim", `Full output: ${sanitizeText(data.fullOutputPath)}`),
                      0,
                      0,
                    ).render(width),
                  );
                if (
                  !options.expanded &&
                  (lines.length > visible.length || errorLines.length > visibleErrors.length) &&
                  retained.length <= calls.length
                )
                  rendered.push(...hint(theme).render(width));
                return rendered;
              },
              invalidate() {
                nativeOutput.invalidate();
                nativeErrors?.invalidate();
              },
            });
          }
          if (retained.length > calls.length) body.addChild(hint(theme));
          return fit(body);
        },
      };
    },
  };
}

function displayResult(
  result: AgentToolResult<unknown>,
  includeDetails = true,
): AgentToolResult<unknown> {
  return {
    content: bounded(
      result.content.filter((part) => part.type === "text"),
    ) as AgentToolResult<unknown>["content"],
    details: includeDetails ? bounded(result.details) : undefined,
  };
}

function renderCall(
  call: DisplayCall,
  tool: Renderer | undefined,
  theme: Theme,
  outer: Context,
): Component {
  const partial = call.status === "running";
  const error = call.status === "error";
  const state: Record<string, unknown> = {};
  const input =
    call.name === "apply_patch" && typeof call.args === "string" ? { input: call.args } : call.args;
  const context: Context = {
    ...outer,
    args: input,
    toolCallId: call.id,
    state,
    argsComplete: true,
    executionStarted: true,
    isPartial: partial,
    isError: error,
    invalidate() {},
    lastComponent: undefined,
  };
  const args = call.args as Record<string, unknown> | undefined;
  const summary =
    call.name === "exec_command"
      ? args?.cmd
      : call.name === "view_image"
        ? args?.path
        : call.name === "write_stdin"
          ? `${args?.chars ? "input to" : "poll"} session ${typeof args?.session_id === "number" ? args.session_id : "unknown"}`
          : undefined;
  const glyph = partial
    ? theme.fg("warning", "…")
    : call.status === "interrupted"
      ? theme.fg("dim", "—")
      : error
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
  const exit = (call.result?.details as Partial<UnifiedExecResult> | undefined)?.exit_code;
  const duration =
    (call.durationMs === undefined ? "" : ` · ${call.durationMs}ms`) +
    (typeof exit === "number" && exit !== 0 ? ` · exit ${exit}` : "");
  const row = new Container();
  row.addChild(
    new Text(
      `${glyph} ${theme.bold(call.name)}${theme.fg("accent", `${typeof summary === "string" ? ` ${summary}` : ""}${duration}`)}`,
      0,
      0,
    ),
  );
  const result = call.result;
  if (call.name === "exec_command" || call.name === "write_stdin") {
    if (result) {
      const details = result.details as Partial<UnifiedExecResult> | undefined;
      if (!partial && details?.output === "")
        row.addChild(new Text("\n" + theme.fg("dim", "(no output)"), 0, 0));
      row.addChild(
        renderExecResult(
          result as AgentToolResult<UnifiedExecResult>,
          { expanded: outer.expanded, isPartial: partial, showInputTokens: false },
          theme,
          { isError: error, state: {} },
        ),
      );
    }
  } else if (
    tool &&
    input &&
    typeof input === "object" &&
    (call.name === "apply_patch" || call.name === "web_run")
  ) {
    // Patch results carry the pre-mutation diff. Hydrate before rendering; never
    // reconstruct a saved patch against today's filesystem.
    if (result)
      tool.renderResult?.(result, { expanded: outer.expanded, isPartial: partial }, theme, context);
    row.addChild(new Text(" ", 0, 0));
    const snapshot = (result?.details as { render?: unknown } | undefined)?.render;
    const child = tool.renderCall?.(
      input as never,
      theme,
      call.name === "apply_patch" && !snapshot
        ? { ...context, argsComplete: false, isPartial: true }
        : context,
    );
    if (child) row.addChild(child);
    if (call.name === "web_run" && result)
      tool.renderResult?.(result, { expanded: outer.expanded, isPartial: partial }, theme, context);
    if (error && result && !(call.name === "web_run" && outer.expanded))
      row.addChild(detailsText(textContent(result), outer.expanded, theme));
    else if (call.name === "web_run" && !outer.expanded && result && textContent(result))
      row.addChild(hint(theme));
  } else if (error && result) row.addChild(detailsText(textContent(result), outer.expanded, theme));
  if (call.status === "interrupted")
    row.addChild(new Text("\n" + theme.fg("dim", "No final result retained (script ended)"), 0, 0));
  return fit(row);
}
function textContent(result: AgentToolResult<unknown>) {
  return result.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
function detailsText(text: string, expanded: boolean, theme: Theme) {
  const lines = sanitizeText(text).split("\n");
  const component = new Container();
  component.addChild(
    new Text(
      "\n" + (expanded ? lines : lines.slice(0, 8)).map((line) => theme.fg("dim", line)).join("\n"),
      0,
      0,
    ),
  );
  if (!expanded && lines.length > 8) component.addChild(hint(theme));
  return component;
}
function hint(theme: Theme) {
  let label: string;
  try {
    label = keyHint("app.tools.expand", "to expand");
  } catch {
    label = "ctrl+o to expand";
  }
  return new Text(theme.fg("dim", `(${label})`), 0, 0);
}
function fit(component: Component): Component {
  let renderedWidth: number | undefined;
  let renderedLines: string[] | undefined;
  return {
    render(width) {
      if (!renderedLines || width !== renderedWidth) {
        renderedLines = component.render(width).map((line) => truncateToWidth(line, width, "…"));
        renderedWidth = width;
      }
      return renderedLines;
    },
    invalidate() {
      component.invalidate();
      renderedLines = undefined;
    },
  };
}
