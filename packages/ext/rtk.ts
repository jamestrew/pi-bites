import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const RTK_COMMAND = process.env.RTK_PATH || "rtk";
const REWRITE_TIMEOUT_MS = 2_000;
const RTK_NO_HOOK_WARNING =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";

export function stripRtkNoHookWarning(raw: string): string {
  return raw
    .split(/(?<=\n)/)
    .filter((line) => line.replace(/\r?\n$/, "") !== RTK_NO_HOOK_WARNING)
    .join("");
}

export function createRtkNoHookWarningDataFilter(
  onData: (data: Buffer) => void,
): (data: Buffer) => void {
  let pending = "";
  let warningTerminator: "none" | "newline" | "line-feed" = "none";

  return (data) => {
    let chunk = data.toString();
    if (warningTerminator === "line-feed" && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
      warningTerminator = "none";
    }

    if (warningTerminator === "newline" && chunk.startsWith("\r\n")) {
      chunk = chunk.slice(2);
      warningTerminator = "none";
    } else if (warningTerminator === "newline" && chunk === "\r") {
      warningTerminator = "line-feed";
      return;
    } else if (warningTerminator === "newline" && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
      warningTerminator = "none";
    }

    pending += chunk;
    const lines = pending.split(/(?<=\n)/);
    pending = pending.endsWith("\n") ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      if (line.replace(/\r?\n$/, "") !== RTK_NO_HOOK_WARNING) onData(Buffer.from(line));
    }

    if (pending === RTK_NO_HOOK_WARNING) {
      pending = "";
      warningTerminator = "newline";
    }

    if (pending.length > RTK_NO_HOOK_WARNING.length + 2) {
      onData(Buffer.from(pending));
      pending = "";
    }
  };
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
    try {
      const available = await refreshRtkAvailability();
      if (!available && !missingWarningShown) {
        missingWarningShown = true;
        const message = `[rtk] ${RTK_COMMAND} binary not found — command rewrite disabled`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(message);
      }
    } catch (err) {
      rtkAvailable = false;
      if (!missingWarningShown) {
        missingWarningShown = true;
        const message = `[rtk] failed to check ${RTK_COMMAND} — command rewrite disabled`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(message, err);
      }
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    if (event.excludeFromContext) return undefined;
    if (process.env.RTK_DISABLED === "1") return undefined;
    if (!rtkAvailable) return undefined;

    return {
      operations: {
        exec: async (command, cwd, options) => {
          let commandToRun = command;

          if (typeof command === "string" && command.trim() !== "" && !command.startsWith("rtk ")) {
            const rewritten = await rewriteCommand(pi, command, options.signal);
            if (rewritten && rewritten !== command) {
              commandToRun = rewritten;
              if (ctx.hasUI) ctx.ui.notify(formatRewriteNotice(command, rewritten), "info");
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
    return { content };
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "bash") return undefined;

      const command = event.input.command;
      if (typeof command !== "string" || command.trim() === "") return undefined;
      if (command.startsWith("rtk ")) return undefined;
      if (process.env.RTK_DISABLED === "1") return undefined;
      if (!rtkAvailable) return undefined;

      const rewritten = await rewriteCommand(pi, command, ctx.signal);
      if (!rewritten || rewritten === command) return undefined;

      event.input.command = rewritten;
      if (ctx.hasUI) ctx.ui.notify(formatRewriteNotice(command, rewritten), "info");
      return undefined;
    } catch (err) {
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", err);
      return undefined;
    }
  });
}
