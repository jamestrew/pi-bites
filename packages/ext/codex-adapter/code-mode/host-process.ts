import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;

export interface HostLimits {
  /** Linux RSS watchdog, sampled every 100ms. Not an OS sandbox or a hard allocation cap. */
  maxResidentBytes?: number;
  startupTimeoutMs?: number;
}

type HostProcessOptions = {
  limits?: HostLimits;
  binary: string;
  onMessage: (message: unknown) => void;
  onFailure: (error: Error) => void;
};

export class CodeModeHostProcess {
  private readonly binary: string;
  private readonly onMessage: (message: unknown) => void;
  private readonly onFailure: (error: Error) => void;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private queuedWriteBytes = 0;
  private closed: Promise<void> = Promise.resolve();
  private monitor: ReturnType<typeof setTimeout> | undefined;
  private readonly maxResidentBytes: number;

  constructor(options: HostProcessOptions) {
    this.binary = options.binary;
    this.maxResidentBytes = options.limits?.maxResidentBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResidentBytes) || this.maxResidentBytes <= 0)
      throw new Error("Invalid Code Mode host memory limit");
    this.onMessage = options.onMessage;
    this.onFailure = options.onFailure;
  }

  async start(): Promise<void> {
    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.monitorMemory(child);
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    child.stdin.on("error", (error) => {
      if (this.child === child) this.onFailure(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.onData(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child === child) this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
    });
    child.on("error", (error) => {
      if (this.child === child) this.onFailure(error);
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.on("close", (code) => {
      if (this.child === child)
        this.onFailure(
          new Error(
            `Code-mode host exited with code ${code ?? "unknown"}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
          ),
        );
    });
    await spawned;
  }

  send(message: unknown): void {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("Code-mode host is not running");
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME_BYTES)
      throw new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length);
    const frame = Buffer.concat([header, payload]);
    if (this.queuedWriteBytes + frame.length > MAX_QUEUED_WRITE_BYTES)
      throw new Error(`Code-mode write queue exceeds ${MAX_QUEUED_WRITE_BYTES} bytes`);
    this.queuedWriteBytes += frame.length;
    child.stdin.write(frame, (error) => {
      this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - frame.length);
      if (error && this.child === child) this.onFailure(error);
    });
  }

  kill(): Promise<void> {
    this.queuedWriteBytes = 0;
    clearTimeout(this.monitor);
    this.monitor = undefined;
    const child = this.child;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    if (child && !child.killed) child.kill("SIGKILL");
    return this.closed;
  }

  private monitorMemory(child: ChildProcessWithoutNullStreams): void {
    this.monitor = setTimeout(() => {
      if (this.child !== child || !child.pid) return;
      void readFile(`/proc/${child.pid}/status`, "utf8").then(
        (status) => {
          if (this.child !== child) return;
          const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
          if (rss && Number(rss[1]) * 1024 > this.maxResidentBytes) {
            this.onFailure(
              new Error(
                `Code Mode host resident memory limit (${this.maxResidentBytes} bytes) exceeded; cells and stored values were cleared`,
              ),
            );
          } else this.monitorMemory(child);
        },
        (error: unknown) => {
          if (this.child !== child) return;
          // A disappearing proc entry means the close event is about to report exit.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            this.onFailure(new Error(`Cannot monitor Code Mode host memory: ${String(error)}`));
        },
      );
    }, 100);
    this.monitor.unref();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onFailure(new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.onMessage(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        this.onFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }
}
