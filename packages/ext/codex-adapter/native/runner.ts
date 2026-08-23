import { spawn } from "node:child_process";
import { formatNativeBinaryError, nativeBinaryRecoveryMessage } from "../native-binary-error.js";

export interface RunBundledToolOptions {
  binary: string;
  args: string[];
  stdin?: string | undefined;
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  maxBuffer?: number | undefined;
  signal?: AbortSignal | undefined;
  label?: string | undefined;
}

export interface BundledToolResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export function runBundledTool({
  binary,
  args,
  stdin,
  cwd,
  env,
  maxBuffer,
  signal,
  label,
}: RunBundledToolOptions): Promise<BundledToolResult> {
  return new Promise((resolve, reject) => {
    const toolLabel = label ?? "tool";
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    const outputLimit = maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    let stdinError: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binary, args, {
      cwd,
      env: env ?? process.env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const terminate = () => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimer.unref();
    };
    const stop = (error: Error) => {
      terminalError ??= error;
      terminate();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > outputLimit) {
        stop(new Error(`${toolLabel} output exceeded ${outputLimit} bytes`));
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    const onAbort = () => stop(new Error("Operation aborted"));

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.on("error", (error) => {
      terminalError ??= new Error(
        formatNativeBinaryError(toolLabel, error, { binaryPath: binary }),
      );
    });
    child.on("close", (status, exitSignal) =>
      finish(() => {
        const nativeFailure =
          status === 0 ? undefined : nativeBinaryRecoveryMessage(toolLabel, stderr || stdout);
        if (terminalError) reject(terminalError);
        else if (nativeFailure) reject(new Error(nativeFailure));
        else if (stdinError && status === 0 && !exitSignal) reject(stdinError);
        else resolve({ stdout, stderr, status, signal: exitSignal });
      }),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (stdin !== undefined) {
      child.stdin?.on("error", (error) => {
        if (settled) return;
        stdinError = error;
        terminate();
      });
      child.stdin?.end(stdin);
    }
  });
}

export function parseSingleJsonLine<T>(stdout: string, label: string): T {
  const jsonLine = stdout
    .trimEnd()
    .split("\n")
    .reverse()
    .find((line: string) => line.trimStart().startsWith("{"));
  if (!jsonLine) throw new Error(`${label} did not return structured JSON output`);
  return JSON.parse(jsonLine) as T;
}
