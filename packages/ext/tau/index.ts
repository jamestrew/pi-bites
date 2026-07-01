import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  TAU_STATUS_SCHEMA_VERSION,
  type TauStatusRecord as TauSessionStatus,
} from "../../tau/status.js";
import type { SnacksConfig } from "../config.js";
import { DEFAULT_EXPLORE_MODEL } from "../explore/index.js";

// Tau readers should treat heartbeatAt as the process-liveness signal, not
// lastEventAt. Pi refreshes heartbeatAt every 20s; readers should consider a
// session stale only after at least 60s without a heartbeat to allow scheduler
// delays, suspend/resume jitter, and slow filesystems.
export const TAU_HEARTBEAT_INTERVAL_MS = 20_000;
export const TAU_READER_STALE_AFTER_MS = 60_000;

export type TauSessionStatusValue =
  | "idle"
  | "working"
  | "needs-input"
  | "needs-permission"
  | "stopped"
  | "stale"
  | "failed";

export interface TauStatusPaths {
  directory: string;
  statusFile: string;
}

export interface TauStatusSessionMetadata {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

export interface BuildTauStatusPayloadOptions extends TauStatusSessionMetadata {
  now: number;
  pid: number;
  ppid?: number;
}

export interface TauStatusContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

interface TauStatusPublisherDeps {
  now: () => number;
  pid: number;
  ppid: number;
  writeSidecar: (payload: TauSessionStatus) => Promise<void>;
  onError: (error: unknown) => void;
}

export type PublishTauStatusOptions = Partial<TauStatusPublisherDeps>;

interface TauStatusRuntimeDeps extends TauStatusPublisherDeps {
  heartbeatIntervalMs: number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export type TauStatusRuntimeOptions = Partial<TauStatusRuntimeDeps>;

export interface TauStatusRuntimeEventMetadata {
  currentAction?: string;
  currentTool?: string;
  lastMessage?: string;
  title?: string;
}

export interface TauStatusRuntime {
  start(ctx: TauStatusContext): Promise<void>;
  recordEvent(
    status?: TauSessionStatusValue,
    metadata?: TauStatusRuntimeEventMetadata,
  ): Promise<void>;
  stop(status?: TauSessionStatusValue): Promise<void>;
}

interface TauTitleGenerationFallback {
  reason: "empty-output" | "error";
  error?: unknown;
}

interface TauTitleGeneratorDeps {
  model: string;
  runPi: (args: string[]) => Promise<string>;
  onFallback: (fallback: TauTitleGenerationFallback) => void;
}

export type TauTitleGeneratorOptions = Partial<TauTitleGeneratorDeps>;

const TAU_TITLE_PROMPT = `
You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"@src/auth.ts can you add refresh token support" -> Auth refresh token support
</examples>`;

export function sanitizeTauGeneratedTitle(title: string): string | undefined {
  const firstLine = title.trim().split(/\r?\n/)[0]?.trim();
  if (!firstLine) return undefined;
  return (
    firstLine
      .replace(/^['"]|['"]$/g, "")
      .slice(0, 50)
      .trim() || undefined
  );
}

function titleCaseFirstWord(text: string): string {
  return text.replace(/^\p{Ll}/u, (char) => char.toLocaleUpperCase());
}

function imperativeVerb(verb: string): string {
  const normalized = verb.toLowerCase();
  if (normalized === "shown") return "Show";
  if (normalized === "displayed") return "Display";
  if (normalized === "rendered") return "Render";
  if (normalized === "added") return "Add";
  return titleCaseFirstWord(verb.replace(/ed$/, ""));
}

export function fallbackTauSessionTitle(message: string): string {
  const text = message
    .replace(/@([^\s/]+\/)*([^\s]+)/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  const wantMatch = text.match(/\bI want (?:this |the )?(.+?) to be (\w+)(?: in ([^\s]+))?/i);
  if (wantMatch) {
    const [, subject, verb, location] = wantMatch;
    const title = `${imperativeVerb(verb ?? "show")} ${subject}${location ? ` in ${location}` : ""}`;
    return sanitizeTauGeneratedTitle(title) ?? "New conversation";
  }
  return sanitizeTauGeneratedTitle(text) ?? "New conversation";
}

function logTauTitleFallback(fallback: TauTitleGenerationFallback): void {
  if (fallback.reason === "empty-output") {
    console.warn("pi-bites: Tau title generation returned no usable title; using fallback title");
    return;
  }
  console.warn(`pi-bites: Tau title generation failed; using fallback title: ${fallback.error}`);
}

function createTauTitleGeneratorDeps(
  overrides: TauTitleGeneratorOptions = {},
): TauTitleGeneratorDeps {
  return {
    model: overrides.model ?? DEFAULT_EXPLORE_MODEL,
    runPi:
      overrides.runPi ??
      ((args) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) {
              resolve(stdout);
              return;
            }
            reject(new Error(`pi exited ${code}`));
          });
        })),
    onFallback: overrides.onFallback ?? logTauTitleFallback,
  };
}

export async function generateTauSessionTitle(
  firstUserMessage: string,
  options: TauTitleGeneratorOptions = {},
): Promise<string> {
  const deps = createTauTitleGeneratorDeps(options);
  const prompt = `${TAU_TITLE_PROMPT}\n\n<user_message>\n${firstUserMessage}\n</user_message>`;
  const args = [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-tools",
    "--model",
    deps.model,
    "--thinking",
    "off",
    prompt,
  ];

  try {
    const output = await deps.runPi(args);
    const title = sanitizeTauGeneratedTitle(output);
    if (title) return title;

    deps.onFallback({ reason: "empty-output" });
    return fallbackTauSessionTitle(firstUserMessage);
  } catch (error) {
    deps.onFallback({ reason: "error", error });
    return fallbackTauSessionTitle(firstUserMessage);
  }
}

export function getDefaultTauAgentsDir(agentDir = getAgentDir()): string {
  return join(dirname(agentDir), "agents");
}

export function deriveTauStatusPaths(
  sessionId: string,
  agentsDir = getDefaultTauAgentsDir(),
): TauStatusPaths {
  const directory = join(agentsDir, "sessions", sessionId);
  return { directory, statusFile: join(directory, "status.json") };
}

export function buildTauStatusPayload(options: BuildTauStatusPayloadOptions): TauSessionStatus {
  return {
    schemaVersion: TAU_STATUS_SCHEMA_VERSION,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    cwd: options.cwd,
    pid: options.pid,
    ...(options.ppid === undefined ? {} : { ppid: options.ppid }),
    startedAt: options.now,
    heartbeatAt: options.now,
    lastEventAt: options.now,
    status: "idle",
  };
}

export async function writeTauStatusSidecar(
  payload: TauSessionStatus,
  paths = deriveTauStatusPaths(payload.sessionId),
): Promise<void> {
  await mkdir(paths.directory, { recursive: true });

  const tempFile = join(
    paths.directory,
    `.status.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await rename(tempFile, paths.statusFile);
}

function logTauStatusPublishError(error: unknown): void {
  console.error(`pi-bites: failed to write Tau status sidecar: ${error}`);
}

function createTauStatusPublisherDeps(
  overrides: PublishTauStatusOptions = {},
): TauStatusPublisherDeps {
  return {
    now: overrides.now ?? Date.now,
    pid: overrides.pid ?? process.pid,
    ppid: overrides.ppid ?? process.ppid,
    writeSidecar: overrides.writeSidecar ?? writeTauStatusSidecar,
    onError: overrides.onError ?? logTauStatusPublishError,
  };
}

function createTauStatusRuntimeDeps(overrides: TauStatusRuntimeOptions = {}): TauStatusRuntimeDeps {
  return {
    ...createTauStatusPublisherDeps(overrides),
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? TAU_HEARTBEAT_INTERVAL_MS,
    setInterval: overrides.setInterval ?? setInterval,
    clearInterval: overrides.clearInterval ?? clearInterval,
  };
}

async function writeTauStatusSafely(
  payload: TauSessionStatus,
  deps: Pick<TauStatusPublisherDeps, "writeSidecar" | "onError">,
): Promise<void> {
  try {
    await deps.writeSidecar(payload);
  } catch (error) {
    deps.onError(error);
  }
}

export async function publishTauStatusForSession(
  ctx: TauStatusContext,
  options: PublishTauStatusOptions = {},
): Promise<void> {
  const deps = createTauStatusPublisherDeps(options);
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;

  const payload = buildTauStatusPayload({
    sessionId,
    sessionFile,
    cwd: ctx.cwd,
    pid: deps.pid,
    ppid: deps.ppid,
    now: deps.now(),
  });

  await writeTauStatusSafely(payload, deps);
}

export function createTauStatusRuntime(options: TauStatusRuntimeOptions = {}): TauStatusRuntime {
  const deps = createTauStatusRuntimeDeps(options);
  let current: TauSessionStatus | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let writeQueue = Promise.resolve();

  const enqueueWrite = (payload: TauSessionStatus): Promise<void> => {
    const write = writeQueue.then(() => writeTauStatusSafely(payload, deps));
    writeQueue = write.catch(() => {});
    return write;
  };
  const writeCurrent = async () => {
    if (current) await enqueueWrite({ ...current });
  };
  const clearHeartbeat = () => {
    if (!heartbeatTimer) return;
    deps.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  return {
    async start(ctx) {
      clearHeartbeat();

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;

      current = buildTauStatusPayload({
        sessionId,
        sessionFile,
        cwd: ctx.cwd,
        pid: deps.pid,
        ppid: deps.ppid,
        now: deps.now(),
      });
      await writeCurrent();

      heartbeatTimer = deps.setInterval(() => {
        if (!current) return;
        current = { ...current, heartbeatAt: deps.now() };
        void writeCurrent();
      }, deps.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },

    async recordEvent(status = current?.status ?? "idle", metadata = {}) {
      if (!current) return;
      const eventAt = deps.now();
      const next: TauSessionStatus = {
        ...current,
        status,
        heartbeatAt: eventAt,
        lastEventAt: eventAt,
      };

      if ("currentAction" in metadata) {
        if (metadata.currentAction === undefined) delete next.currentAction;
        else next.currentAction = metadata.currentAction;
      }
      if ("currentTool" in metadata) {
        if (metadata.currentTool === undefined) delete next.currentTool;
        else next.currentTool = metadata.currentTool;
      }
      if ("lastMessage" in metadata) {
        if (metadata.lastMessage === undefined) delete next.lastMessage;
        else next.lastMessage = metadata.lastMessage;
      }
      if ("title" in metadata) {
        if (metadata.title === undefined) delete next.title;
        else next.title = metadata.title;
      }

      current = next;
      await writeCurrent();
    },

    async stop(status = "stopped") {
      clearHeartbeat();
      if (!current) return;
      const stoppedAt = deps.now();
      current = { ...current, status, heartbeatAt: stoppedAt, lastEventAt: stoppedAt };
      delete current.currentAction;
      delete current.currentTool;
      await writeCurrent();
      current = undefined;
    },
  };
}

function extractTextMessage(message: { content?: unknown }): string | undefined {
  if (typeof message.content === "string") return message.content.trim() || undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = (message.content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || undefined;
}

function describeToolAction(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string" && input.command.trim() !== "") {
    return `Running ${input.command.trim()}`;
  }
  return `Running ${toolName}`;
}

interface TauStatusHandlerDeps {
  generateTitle: (firstUserMessage: string) => Promise<string>;
}

export interface RegisterTauStatusHandlersOptions {
  generateTitle?: (firstUserMessage: string) => Promise<string>;
  titleModel?: () => string | undefined;
}

function createTauStatusHandlerDeps(
  options: RegisterTauStatusHandlersOptions = {},
): TauStatusHandlerDeps {
  return {
    generateTitle:
      options.generateTitle ??
      ((prompt) => generateTauSessionTitle(prompt, { model: options.titleModel?.() })),
  };
}

export function registerTauStatusHandlers(
  pi: Pick<ExtensionAPI, "on" | "events">,
  statusRuntime: TauStatusRuntime,
  options: RegisterTauStatusHandlersOptions = {},
): void {
  const deps = createTauStatusHandlerDeps(options);
  let agentRunActive = false;
  let permissionGateActive = false;
  let titleCaptured = false;
  const activeTools = new Map<string, TauStatusRuntimeEventMetadata>();

  const currentToolMetadata = (): TauStatusRuntimeEventMetadata => {
    const last = Array.from(activeTools.values()).at(-1);
    return last ?? { currentAction: undefined, currentTool: undefined };
  };

  pi.on("session_start", async (_event, ctx) => {
    titleCaptured = false;
    await statusRuntime.start(ctx);
  });

  pi.on("before_agent_start", (event) => {
    void statusRuntime.recordEvent(undefined, { lastMessage: event.prompt });

    if (titleCaptured) return;
    titleCaptured = true;

    void deps
      .generateTitle(event.prompt)
      .then((title) => statusRuntime.recordEvent(undefined, { title }))
      .catch(() => {});
  });

  pi.on("agent_start", async () => {
    agentRunActive = true;
    await statusRuntime.recordEvent("working");
  });

  pi.on("tool_call", async (event) => {
    const metadata = {
      currentAction: describeToolAction(event.toolName, event.input),
      currentTool: event.toolName,
    };
    activeTools.set(event.toolCallId, metadata);
    await statusRuntime.recordEvent(
      permissionGateActive ? "needs-permission" : "working",
      metadata,
    );
  });

  pi.events.on("bites:bash_gate", async (data) => {
    permissionGateActive = true;
    const command = (data as { command?: unknown }).command;
    await statusRuntime.recordEvent("needs-permission", {
      currentAction:
        typeof command === "string" && command.trim() !== ""
          ? `Approve ${command.trim()}`
          : "Approve bash command",
      currentTool: "bash",
    });
  });

  pi.events.on("bites:bash_gate_resolved", async () => {
    permissionGateActive = false;
    await statusRuntime.recordEvent(agentRunActive ? "working" : "idle", currentToolMetadata());
  });

  pi.on("tool_result", async (event) => {
    activeTools.delete(event.toolCallId);
    const metadata = currentToolMetadata();
    await statusRuntime.recordEvent(agentRunActive ? "working" : "idle", metadata);
  });

  pi.on("agent_end", async (event) => {
    agentRunActive = false;
    activeTools.clear();
    const assistantMessage = [...(event?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    await statusRuntime.recordEvent("idle", {
      currentAction: undefined,
      currentTool: undefined,
      lastMessage: assistantMessage ? extractTextMessage(assistantMessage) : undefined,
    });
  });

  pi.on("turn_end", async () => {
    if (!agentRunActive)
      await statusRuntime.recordEvent("idle", { currentAction: undefined, currentTool: undefined });
  });

  pi.on("session_shutdown", async () => {
    await statusRuntime.stop("stopped");
  });
}

export default function registerTau(
  pi: ExtensionAPI,
  configRef: { current: SnacksConfig } = { current: {} },
): void {
  const statusRuntime = createTauStatusRuntime();
  registerTauStatusHandlers(pi, statusRuntime, {
    titleModel: () => configRef.current.explore?.defaultModel ?? DEFAULT_EXPLORE_MODEL,
  });

  // /agents -----------------------------------------------------------------
  pi.registerCommand("agents", {
    description:
      "Return to Tau or another waiting parent by cooperatively shutting down this Pi session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Shutting down Pi. If this session was launched from Tau or another waiting parent, control will return there.",
        "info",
      );
      ctx.shutdown();
    },
  });
}
