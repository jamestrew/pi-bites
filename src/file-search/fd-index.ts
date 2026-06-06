import { spawn } from "node:child_process";

const FD_ARGS = [
  "--type",
  "f",
  "--type",
  "d",
  "--hidden",
  "--exclude",
  ".git",
  "--strip-cwd-prefix",
];

function normalizeFdPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export async function listProjectPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");

  return await new Promise((resolve, reject) => {
    const child = spawn("fd", FD_ARGS, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onAbort = () => {
      child.kill();
      finish(() => reject(new DOMException("Operation aborted", "AbortError")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code, signalName) => {
      if (settled) return;

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const detail =
          stderr || `exit code ${code ?? "unknown"}${signalName ? `, signal ${signalName}` : ""}`;
        finish(() => reject(new Error(`fd failed: ${detail}`)));
        return;
      }

      const paths = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .split("\n")
        .map((path) => normalizeFdPath(path.trimEnd()))
        .filter((path) => path.length > 0);

      finish(() => resolve([...new Set(paths)].sort()));
    });
  });
}
