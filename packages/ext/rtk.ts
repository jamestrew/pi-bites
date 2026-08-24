import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const RTK_COMMAND = process.env.RTK_PATH || "rtk";
const REWRITE_TIMEOUT_MS = 2_000;
const RTK_NO_HOOK_WARNING =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";
const rtkExecInputs = new WeakMap<object, string>();

export function consumeRtkExecInput(input: object): string | undefined {
  // Pi passes the validated tool input object through tool_call and then execute.
  // Consuming by identity avoids session-global tool-call state surviving cancellation.
  const originalCommand = rtkExecInputs.get(input);
  rtkExecInputs.delete(input);
  return originalCommand;
}

export function stripRtkNoHookWarning(raw: string): string {
  return raw
    .split(/(?<=\n)/)
    .filter((line) => line.replace(/\r?\n$/, "") !== RTK_NO_HOOK_WARNING)
    .join("");
}

export interface RtkNoHookWarningDataFilter {
  (data: Buffer, stream?: string): void;
  end(): void;
}

export function createRtkNoHookWarningDataFilter(
  onData: (data: Buffer) => void,
): RtkNoHookWarningDataFilter {
  const warning = Buffer.from(RTK_NO_HOOK_WARNING);
  interface PendingByte {
    byte: number;
    keep?: boolean;
  }
  interface StreamState {
    candidate: PendingByte[];
    atLineStart: boolean;
    matchedWarning: boolean;
    pendingCarriageReturn: boolean;
  }
  const pending: PendingByte[] = [];
  const streams = new Map<string, StreamState>();

  const resolve = (bytes: PendingByte[], keep: boolean) => {
    for (const byte of bytes) byte.keep = keep;
    bytes.length = 0;
  };

  const flush = () => {
    const output: number[] = [];
    let resolved = 0;
    while (pending[resolved]?.keep !== undefined) {
      const next = pending[resolved];
      if (next?.keep) output.push(next.byte);
      resolved += 1;
    }
    if (resolved) pending.splice(0, resolved);
    if (output.length) onData(Buffer.from(output));
  };

  const filter = (data: Buffer, stream = "output") => {
    const state = streams.get(stream) ?? {
      candidate: [],
      atLineStart: true,
      matchedWarning: false,
      pendingCarriageReturn: false,
    };
    streams.set(stream, state);
    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index];
      if (byte === undefined) break;
      const current: PendingByte = { byte };
      pending.push(current);

      if (state.matchedWarning) {
        if (state.pendingCarriageReturn) {
          if (byte === 0x0a) {
            state.candidate.push(current);
            resolve(state.candidate, false);
            state.matchedWarning = false;
            state.pendingCarriageReturn = false;
            state.atLineStart = true;
            continue;
          }
          resolve(state.candidate, true);
          state.matchedWarning = false;
          state.pendingCarriageReturn = false;
          state.atLineStart = false;
          current.keep = true;
          if (byte === 0x0a) state.atLineStart = true;
          continue;
        }
        if (byte === 0x0a) {
          state.candidate.push(current);
          resolve(state.candidate, false);
          state.matchedWarning = false;
          state.atLineStart = true;
          continue;
        }
        if (byte === 0x0d) {
          state.candidate.push(current);
          state.pendingCarriageReturn = true;
          continue;
        }
        resolve(state.candidate, true);
        state.matchedWarning = false;
        state.atLineStart = false;
        current.keep = true;
        continue;
      }

      if (!state.atLineStart) {
        current.keep = true;
        if (byte === 0x0a) state.atLineStart = true;
        continue;
      }

      state.candidate.push(current);
      if (byte === warning[state.candidate.length - 1]) {
        if (state.candidate.length < warning.length) continue;
        state.matchedWarning = true;
        continue;
      }

      resolve(state.candidate, true);
      state.atLineStart = byte === 0x0a;
    }
    flush();
  };

  filter.end = () => {
    for (const state of streams.values()) {
      resolve(state.candidate, !state.matchedWarning || state.pendingCarriageReturn);
    }
    flush();
    streams.clear();
  };
  return filter;
}

function trimMessage(raw: string, maxLength: number): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}…`;
}

function formatRewriteNotice(originalCommand: string, rewrittenCommand: string): string {
  const original = trimMessage(originalCommand, 100);
  const rewritten = trimMessage(rewrittenCommand, 120);
  return `RTK rewrite: ${original} -> ${rewritten}`;
}

function commandField(toolName: string): "command" | "cmd" | undefined {
  if (toolName === "bash") return "command";
  if (toolName === "exec_command") return "cmd";
  return undefined;
}

function alreadyUsesRtk(command: string): boolean {
  const candidate = command.trimStart();
  const commands = [
    RTK_COMMAND,
    ...(RTK_COMMAND.includes("'") ? [] : [`'${RTK_COMMAND}'`]),
    ...(RTK_COMMAND.includes('"') ? [] : [`"${RTK_COMMAND}"`]),
  ];
  return commands.some(
    (rtk) =>
      candidate === rtk ||
      (candidate.startsWith(rtk) && /[\s;&|<>()]/.test(candidate.charAt(rtk.length))),
  );
}

async function rewriteCommand(
  pi: ExtensionAPI,
  command: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await pi.exec(RTK_COMMAND, ["rewrite", command], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  });

  if (result.killed) return null;
  if (result.code !== 0 && result.code !== 3) return null;
  return result.stdout.trim() || null;
}

export default function registerRtk(pi: ExtensionAPI): void {
  const localBash = createLocalBashOperations();
  let rtkAvailable = true;
  let missingWarningShown = false;

  async function refreshRtkAvailability(): Promise<boolean> {
    const result = await pi.exec(RTK_COMMAND, ["--version"], { timeout: REWRITE_TIMEOUT_MS });
    rtkAvailable = result.code === 0;
    if (rtkAvailable) missingWarningShown = false;
    return rtkAvailable;
  }

  pi.on("session_start", async (_event, ctx) => {
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    try {
      const available = await refreshRtkAvailability();
      if (!available && !missingWarningShown) {
        missingWarningShown = true;
        const message = `[rtk] ${RTK_COMMAND} binary not found — command rewrite disabled`;
        if (hasUI) ui.notify(message, "warning");
        else console.warn(message);
      }
    } catch (err) {
      rtkAvailable = false;
      if (!missingWarningShown) {
        missingWarningShown = true;
        const message = `[rtk] failed to check ${RTK_COMMAND} — command rewrite disabled`;
        if (hasUI) ui.notify(message, "warning");
        else console.warn(message, err);
      }
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    if (event.excludeFromContext) return undefined;
    if (process.env.RTK_DISABLED === "1") return undefined;
    if (!rtkAvailable) return undefined;
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;

    return {
      operations: {
        exec: async (command, cwd, options) => {
          let commandToRun = command;

          if (typeof command === "string" && command.trim() !== "" && !alreadyUsesRtk(command)) {
            const rewritten = await rewriteCommand(pi, command, options.signal);
            if (rewritten && rewritten !== command) {
              commandToRun = rewritten;
              if (hasUI) ui.notify(formatRewriteNotice(command, rewritten), "info");
            }
          }

          return localBash.exec(commandToRun, cwd, {
            ...options,
            onData: createRtkNoHookWarningDataFilter(options.onData),
          });
        },
      },
    };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const content = event.content.map((item) =>
      item.type === "text" ? { ...item, text: stripRtkNoHookWarning(item.text) } : item,
    );
    const details = event.details;
    if (!details || typeof details !== "object" || !("output" in details)) return { content };
    const output = details.output;
    return {
      content,
      details:
        typeof output === "string"
          ? { ...details, output: stripRtkNoHookWarning(output) }
          : details,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const field = commandField(event.toolName);
    if (!field) return undefined;
    const input = event.input as Record<string, unknown>;
    const command = input[field];
    if (typeof command !== "string" || command.trim() === "") return undefined;
    if (process.env.RTK_DISABLED === "1") return undefined;
    if (alreadyUsesRtk(command)) {
      if (event.toolName === "exec_command") rtkExecInputs.set(input, command);
      return undefined;
    }
    if (!rtkAvailable) return undefined;

    const signal = ctx.signal;
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    try {
      const rewritten = await rewriteCommand(pi, command, signal);
      if (signal?.aborted) return { block: true, reason: "RTK rewrite cancelled." };
      if (!rewritten || rewritten === command) return undefined;

      input[field] = rewritten;
      if (event.toolName === "exec_command") rtkExecInputs.set(input, command);
      if (hasUI) ui.notify(formatRewriteNotice(command, rewritten), "info");
      return undefined;
    } catch (err) {
      if (signal?.aborted) return { block: true, reason: "RTK rewrite cancelled." };
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", err);
      return undefined;
    }
  });
}
