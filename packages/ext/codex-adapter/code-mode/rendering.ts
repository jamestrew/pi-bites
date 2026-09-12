import type { TSchema } from "typebox";
import { createHash } from "node:crypto";
import {
  Box,
  Container,
  Image,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sanitizeText } from "../../subagents/ui/text-lines.js";
import type { OwnedNestedTools } from "./nested-tools.js";
import type { NestedTrace } from "./nested-traces.js";
import type { CodeModeDetails } from "./results.js";

type ToolRenderContext<S = Record<string, unknown>> = Parameters<
  NonNullable<ToolDefinition<TSchema, unknown, S>["renderCall"]>
>[2];
type Renderer = Pick<
  ToolDefinition<TSchema, unknown, Record<string, unknown>>,
  "renderCall" | "renderResult" | "renderShell"
>;
interface ChildState {
  state: Record<string, unknown>;
  call?: Component;
  result?: Component;
  images?: Map<string, Image>;
}
interface RenderState {
  hasResult?: boolean;
  children?: Map<string, ChildState>;
}
interface Owner {
  version: number;
  invalidate: () => void;
}
const imageKey = (item: { data: string; mimeType: string }) =>
  createHash("sha256").update(item.mimeType).update(item.data).digest("hex");

/** Display ownership is independent of runtime lifetime. A newer saved observation moves the
 * cell's nested rows to that observation, including when Pi replays a restored transcript.
 * Only weak references to UI owners and image fingerprints live outside Pi's row state.
 */
export function createCodeModeRendering(owned: OwnedNestedTools) {
  // The dispatcher validates concrete inputs; persisted display snapshots deliberately erase
  // each tool's parameter/result types. Keep that erasure at this presentation boundary.
  const renderers = owned as unknown as Record<string, Renderer>;
  const owners = new Map<
    string,
    { version: number; owner: WeakRef<Owner>; emitted: Set<string> }
  >();
  const forTool = (name: "exec" | "wait") => ({
    renderShell: "self" as const,
    renderCall(_args: unknown, theme: Theme, context: ToolRenderContext<RenderState>) {
      const pending = frame(theme, true, false);
      pending.addChild(
        new Text(scanline(name, name === "exec" ? "executing" : "waiting", theme), 0, 0),
      );
      return {
        render: (width: number) =>
          context.state.hasResult ? [] : fitLines(pending.render(width), width),
        invalidate: () => pending.invalidate(),
      };
    },
    renderResult(
      result: AgentToolResult<CodeModeDetails | undefined>,
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: ToolRenderContext<RenderState>,
    ) {
      context.state.hasResult = true;
      const details = result.details;
      const traces = details?.codeMode ? details.traces : [];
      const version = details?.displayVersion ?? 0;
      const previous = details?.codeMode ? owners.get(details.cellId) : undefined;
      const emitted = previous?.emitted ?? new Set<string>();
      const previousEmissions = emitted.size;
      for (const item of result.content) if (item.type === "image") emitted.add(imageKey(item));
      const owner: Owner = { version, invalidate: context.invalidate };
      if (details?.codeMode && (!previous || version >= previous.version)) {
        owners.set(details.cellId, { version, owner: new WeakRef(owner), emitted });
        if (previous && version > previous.version) previous.owner.deref()?.invalidate();
      }
      if (previous && emitted.size !== previousEmissions) previous.owner.deref()?.invalidate();
      const children = (context.state.children ??= new Map<string, ChildState>());
      for (const id of children.keys())
        if (!traces.some((trace) => trace.callId === id)) children.delete(id);
      return {
        render(width: number) {
          // Keep this owner alive with its component, without retaining the transcript globally.
          const current = details?.codeMode ? owners.get(details.cellId) : undefined;
          const visible = !current || owner.version >= current.version;
          const body = new Container();
          if (visible)
            for (const trace of traces) {
              const child = children.get(trace.callId) ?? { state: {} };
              children.set(trace.callId, child);
              body.addChild(
                renderChild(renderers[trace.name], trace, child, theme, context, emitted),
              );
            }
          const error = details?.errorText;
          const fallbackError = context.isError && !details?.codeMode;
          const standalone = traces.length === 0 && (visible || !!details?.output);
          if (error || fallbackError || standalone) {
            const text = fallbackError
              ? textContent(result)
              : standalone
                ? (details?.output ?? textContent({ ...result, content: result.content.slice(1) }))
                : "";
            const status = options.isPartial
              ? name === "exec"
                ? "executing"
                : "waiting"
              : details?.failed || fallbackError
                ? "failed"
                : details?.state === "yielded"
                  ? "running"
                  : details?.state === "terminated"
                    ? "terminated"
                    : "completed";
            const box = frame(theme, options.isPartial, !!error || fallbackError);
            box.addChild(new Text(scanline(name, status, theme), 0, 0));
            if (text || error) box.addChild(output(text, options.expanded, theme, error));
            body.addChild(box);
          }
          return fitLines(body.render(width), width);
        },
        invalidate() {
          for (const child of children.values()) {
            child.call?.invalidate();
            child.result?.invalidate();
            for (const image of child.images?.values() ?? []) image.invalidate();
          }
        },
      };
    },
  });
  return { forTool, reset: () => owners.clear() };
}

function renderChild(
  tool: Renderer | undefined,
  trace: NestedTrace,
  child: ChildState,
  theme: Theme,
  outer: ToolRenderContext<RenderState>,
  emitted: Set<string>,
): Component {
  const partial = trace.state === "running" || trace.state === "approval";
  const error = trace.state === "error";
  // Sanitization is display-only. Inputs/results sent to executors and the model are untouched.
  const args = displayValue(trace.input);
  const result = trace.result
    ? (displayValue(trace.result) as AgentToolResult<unknown>)
    : undefined;
  if (trace.name === "apply_patch" && result && trace.result?.details) {
    // Patch snapshots contain trusted syntax-colored diffs, already sanitized by the patch renderer.
    const snapshot = (trace.result.details as { render?: unknown }).render;
    if (snapshot) {
      child.state.snapshot = snapshot;
      result.details = trace.result.details;
    }
  }
  const invalidation = { dirty: false };
  const context: ToolRenderContext = {
    ...outer,
    cwd: trace.cwd ?? outer.cwd,
    args,
    toolCallId: trace.callId,
    state: child.state,
    executionStarted: trace.state !== "approval",
    argsComplete: true,
    isPartial: partial,
    isError: error,
    lastComponent: child.call,
    invalidate: () => {
      invalidation.dirty = true;
    },
  };
  const render = () => {
    child.call =
      tool?.renderCall?.(args, theme, { ...context, lastComponent: child.call }) ??
      new Text(scanline(trace.name, "", theme), 0, 0);
    child.result = result
      ? tool?.renderResult?.(result, { expanded: outer.expanded, isPartial: partial }, theme, {
          ...context,
          lastComponent: child.result,
        })
      : undefined;
  };
  try {
    render();
    // Patch results hydrate the call's saved diff; web results mutate the call component.
    if (invalidation.dirty) render();
  } catch {
    // A bounded or older snapshot may lack fields a tool renderer expects.
    child.call = new Text(scanline(trace.name, "", theme), 0, 0);
    child.result = output(
      result ? textContent(result) : "Display details unavailable",
      outer.expanded,
      theme,
    );
  }
  const box = tool?.renderShell === "self" ? new Container() : frame(theme, partial, error);
  if (child.call) box.addChild(child.call);
  if (child.result) box.addChild(child.result);
  const extra = new Container();
  if (trace.name === "web_run" && result && !error && !outer.expanded && textContent(result))
    extra.addChild(output(`(${expandHint()})`, true, theme));
  if (partial && (!result || trace.state === "approval"))
    extra.addChild(
      output(trace.state === "approval" ? "Awaiting approval" : "Running", true, theme),
    );
  if (result && (error || !tool?.renderResult)) {
    // Command renderers already own their error output; call-only renderers need the message.
    if (!tool?.renderResult || trace.name === "apply_patch" || trace.name === "web_run") {
      const text = textContent(result);
      if (text && !(trace.name === "web_run" && outer.expanded))
        extra.addChild(output(text, outer.expanded, theme));
    }
  }
  if (result && outer.showImages)
    for (const item of result.content) {
      if (item.type === "image" && !emitted.has(imageKey(item))) {
        const images = (child.images ??= new Map<string, Image>());
        const key = imageKey(item);
        const image =
          images.get(key) ??
          new Image(
            item.data,
            item.mimeType,
            { fallbackColor: (s) => theme.fg("dim", s) },
            { maxWidthCells: 60 },
          );
        images.set(key, image);
        extra.addChild(image);
      }
    }
  if (tool?.renderShell === "self") {
    // The web renderer supplies its own padding; append extra details inside that same box.
    if (child.call instanceof Box)
      for (const component of extra.children) child.call.addChild(component);
  } else box.addChild(extra);
  return box;
}
function frame(theme: Theme, partial: boolean, error: boolean) {
  return new Box(0, 1, (line) =>
    theme.bg(error ? "toolErrorBg" : partial ? "toolPendingBg" : "toolSuccessBg", line),
  );
}
function scanline(name: string, summary: string, theme: Theme) {
  return theme.bold(name) + (summary ? theme.fg("accent", ` ${summary}`) : "");
}
function textContent(result: Pick<AgentToolResult<unknown>, "content">) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
function output(text: string, expanded: boolean, theme: Theme, trailing?: string): Component {
  const dim = (value: string) =>
    new Text(
      sanitizeText(value)
        .split("\n")
        .map((line) => theme.fg("dim", line))
        .join("\n"),
      0,
      0,
    );
  const component = dim(text);
  const tail = trailing ? dim(trailing) : undefined;
  return {
    render(width) {
      const lines = text ? component.render(width) : [];
      const hidden = !expanded && lines.length > 8;
      const visible = hidden ? lines.slice(0, 8) : lines;
      const result = ["", ...visible];
      if (tail) {
        if (visible.length) result.push("");
        result.push(...tail.render(width));
      }
      if (hidden) result.push(truncateToWidth(theme.fg("dim", `(${expandHint()})`), width));
      return result;
    },
    invalidate() {
      component.invalidate();
      tail?.invalidate();
    },
  };
}

function displayValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(displayValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === "data" ? item : displayValue(item)]),
    );
  return value;
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

function fitLines(lines: string[], width: number): string[] {
  // Match Pi TUI's internal isImageLine predicate; escape payloads must stay intact.
  return lines.map((line) =>
    line.includes("\u001b_G") || line.includes("\u001b]1337;File=")
      ? line
      : truncateToWidth(line, width, "…"),
  );
}
