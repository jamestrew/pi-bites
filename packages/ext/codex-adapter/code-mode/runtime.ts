import type { HostLimits } from "./host-process.js";
import { randomUUID } from "node:crypto";
import { getCodeModeHostPath } from "./binary.js";
import { CodeModeHostConnection } from "./host-connection.js";
import { parseExecSource, unsignedInteger } from "./exec-source.js";
import {
  executionCellId,
  parseRuntimeResponse,
  runtimeOutcome,
  isMissingRuntimeOutcome,
} from "./host-protocol.js";
import { Delegates } from "./delegates.js";
import type { RuntimeResponse, RuntimeTool } from "./types.js";

export interface RuntimeOptions {
  binary?: string;
  hostLimits?: HostLimits;
  tools: RuntimeTool[];
  /** Stable shell manager methods; this runtime never shuts down unrelated sessions. */
  shells?: {
    terminateSession(id: number): boolean;
    onSessionExit(listener: (id: number) => void): () => void;
  };
  onNotification?: (cellId: string, text: string) => void;
  onFailure?: (error: Error) => void;
}

/** One native host per conversation branch. Terminal instances never restart implicitly. */
export class CodeModeRuntime {
  private readonly sessionId = randomUUID();
  private readonly connection: CodeModeHostConnection;
  private readonly delegates: Delegates;
  private readonly tools: RuntimeTool[];
  private ready: Promise<void> | undefined;
  private stopped: Error | undefined;
  private shuttingDown = false;
  private readonly startingExecutions = new Set<symbol>();
  private readonly observing = new Set<string>();

  constructor(options: RuntimeOptions) {
    this.tools = [...options.tools];
    if (new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length)
      throw new Error("Duplicate Code Mode tool names");
    this.connection = new CodeModeHostConnection({
      binary: options.binary ?? getCodeModeHostPath(),
      limits: options.hostLimits,
      onMessage: (message) => {
        if ("sessionId" in message && message.sessionId !== this.sessionId)
          throw new Error("Mismatched Code Mode host session");
        this.delegates.handle(message);
      },
      onFailure: (error) => {
        this.stopped = error;
        this.delegates.clear();
        if (!this.shuttingDown) options.onFailure?.(error);
      },
    });
    this.delegates = new Delegates({
      send: (message) => this.connection.send(message),
      cellPrefix: `${this.sessionId}:`,
      shells: options.shells,
      onNotification: options.onNotification,
      fail: (error) => this.connection.close(error),
    });
  }

  private async start(): Promise<void> {
    this.assertActive();
    this.ready ??= this.connection.start(this.sessionId);
    await this.ready;
    this.assertActive();
  }

  private assertActive(): void {
    if (this.stopped) throw this.stopped;
  }

  async execute(
    source: string,
    signal?: AbortSignal,
    tools: readonly RuntimeTool[] = this.tools,
  ): Promise<RuntimeResponse> {
    const enabledTools = tools.map((tool) => ({ ...tool }));
    if (new Set(enabledTools.map((tool) => tool.name)).size !== enabledTools.length)
      throw new Error("Duplicate Code Mode tool names");
    const parsed = parseExecSource(source);
    signal?.throwIfAborted();
    // Reserve before awaiting startup, so concurrent submissions cannot exceed the bound.
    if (this.startingExecutions.size + this.delegates.cellCount >= 64)
      throw new Error("Code Mode live cell limit (64) exceeded; wait or terminate existing cells");
    const reservation = Symbol();
    this.startingExecutions.add(reservation);
    let cellId: string | undefined;
    let id: number | undefined;
    const abort = () => {
      // An execute cancelled before its started reply cannot safely identify its cell.
      // Keep the started handler alive so it can terminate the cell before dispatch.
      if (cellId) void this.terminate(`${this.sessionId}:${cellId}`).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.start();
      signal?.throwIfAborted();
      id = this.connection.nextRequestId();
      const initial = this.connection.expectInitial(id);
      void initial.catch(() => {});
      await this.connection.requestWithId(
        id,
        {
          method: "session/execute",
          sessionId: this.sessionId,
          request: {
            tool_call_id: `${this.sessionId}:${id}`,
            enabled_tools: enabledTools.map((tool) => ({
              name: tool.name,
              tool_name: { name: tool.name, namespace: null },
              description: tool.description,
              kind: tool.kind,
              input_schema: tool.inputSchema ?? null,
              output_schema: tool.outputSchema ?? null,
            })),
            source: parsed.code,
            yield_time_ms: parsed.yieldTimeMs,
            // Native service does not format output. Keep the safe-integer budget in TS,
            // avoiding protocol V1's narrower optional i32 field.
            max_output_tokens: null,
          },
        },
        (value) => {
          cellId = executionCellId(value);
          if (!cellId) throw new Error("Invalid Code Mode execution start");
          this.delegates.bind(cellId, enabledTools);
          this.startingExecutions.delete(reservation);
          if (signal?.aborted) abort();
        },
      );
      const response = this.consume(await initial, cellId);
      signal?.throwIfAborted();
      return { ...this.expose(response), maxOutputTokens: parsed.maxOutputTokens };
    } catch (error) {
      if (id !== undefined) this.connection.rejectOperation(id, toError(error));
      if (cellId && !this.stopped)
        await this.terminate(`${this.sessionId}:${cellId}`).catch(() => {});
      throw error;
    } finally {
      this.startingExecutions.delete(reservation);
      signal?.removeEventListener("abort", abort);
    }
  }

  async wait(cellId: string, yieldTimeMs = 10_000, signal?: AbortSignal): Promise<RuntimeResponse> {
    unsignedInteger(yieldTimeMs, "yield_time_ms");
    return this.observe(cellId, false, yieldTimeMs, signal);
  }

  async terminate(cellId: string): Promise<RuntimeResponse> {
    validateCellId(cellId);
    // Synchronous invalidation precedes host IO and any queued approval continuation.
    if (cellId.startsWith(`${this.sessionId}:`))
      this.delegates.cancelCell(cellId.slice(this.sessionId.length + 1), true);
    return this.observe(cellId, true);
  }

  private async observe(
    cellId: string,
    terminate: boolean,
    yieldTimeMs = 10_000,
    signal?: AbortSignal,
  ): Promise<RuntimeResponse> {
    validateCellId(cellId);
    signal?.throwIfAborted();
    if (this.stopped) throw this.stopped;
    const prefix = `${this.sessionId}:`;
    if (!cellId.startsWith(prefix))
      return {
        kind: "result",
        cellId,
        contentItems: [],
        missingCell: true,
        errorText: `exec cell ${cellId} not found`,
      };
    const nativeId = cellId.slice(prefix.length);
    const request = terminate
      ? { method: "session/terminate", sessionId: this.sessionId, cellId: nativeId }
      : {
          method: "session/wait",
          sessionId: this.sessionId,
          request: { cell_id: nativeId, yield_time_ms: yieldTimeMs },
        };
    const waiting = !terminate;
    if (waiting && this.observing.has(cellId))
      throw new Error(`Already waiting on Code Mode cell ${cellId}`);
    if (waiting) {
      if (this.observing.size >= 256)
        throw new Error("Code Mode pending observation limit exceeded");
      this.observing.add(cellId);
    }
    let id: number | undefined;
    const abort = () => {
      if (id !== undefined) {
        try {
          this.connection.send({ type: "operation/cancel", id });
        } catch {
          /* failure already propagated */
        }
        this.connection.rejectOperation(id, new Error("Code Mode wait aborted"));
      }
      void this.terminate(cellId).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.start();
      signal?.throwIfAborted();
      id = this.connection.nextRequestId();
      const value = await this.connection.requestWithId(id, request);
      const wrapped = runtimeOutcome(value);
      if (!wrapped) {
        void this.connection.close(new Error("Invalid Code Mode wait outcome"));
        throw new Error("Invalid Code Mode wait outcome");
      }
      return {
        ...this.expose(this.consume(wrapped, nativeId)),
        ...(isMissingRuntimeOutcome(value) ? { missingCell: true } : {}),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (waiting) this.observing.delete(cellId);
    }
  }

  private consume(value: unknown, expectedId: string | undefined): RuntimeResponse {
    try {
      const response = parseRuntimeResponse(value);
      if (response.cellId !== expectedId) throw new Error("Mismatched Code Mode response cell ID");
      return this.delegates.attach(response);
    } catch (error) {
      void this.connection.close(toError(error));
      throw error;
    }
  }

  private expose(response: RuntimeResponse): RuntimeResponse {
    const cellId = `${this.sessionId}:${response.cellId}`;
    return {
      ...response,
      cellId,
      ...(response.errorText === `exec cell ${response.cellId} not found`
        ? { errorText: `exec cell ${cellId} not found` }
        : {}),
    };
  }

  async shutdown(): Promise<void> {
    // Killing this dedicated host clears cells, stored values and native output atomically.
    this.shuttingDown = true;
    await this.connection.close(new Error("Code Mode runtime shut down"));
  }
}

function validateCellId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    throw new Error(
      "cell_id must be a non-empty string of at most 1024 characters (not a shell session ID)",
    );
}
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
