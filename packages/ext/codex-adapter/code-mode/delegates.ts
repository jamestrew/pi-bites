import type { HostMessage, HostResult, DelegateRequestMessage } from "./host-protocol.js";
import type { RuntimeTool, RuntimeResponse } from "./types.js";
import type { RuntimeOptions } from "./runtime.js";

interface Cell {
  tools: ReadonlyMap<string, RuntimeTool>;
  closed: boolean;
  notifications: string[];
  bytes: number;
}
interface Pending {
  cellId: string;
  controller: AbortController;
}
interface Options extends Pick<RuntimeOptions, "shells" | "onNotification"> {
  cellPrefix: string;
  send(message: unknown): void;
  fail(error: Error): void;
}

/** Owns only live dispatch and unconsumed notifications; presentation belongs to #301. */
export class Delegates {
  private readonly cells = new Map<string, Cell>();
  private readonly pending = new Map<number, Pending>();
  private readonly shells = new Map<number, string>();
  private readonly unsubscribe: (() => void) | undefined;
  private stopped = false;
  private inFlight = 0;

  constructor(private readonly options: Options) {
    this.unsubscribe = options.shells?.onSessionExit((id) => this.shells.delete(id));
  }
  get cellCount(): number {
    return this.cells.size;
  }
  bind(cellId: string, tools: readonly RuntimeTool[]): void {
    if (this.stopped) throw new Error("Code Mode runtime is closed");
    this.cells.set(cellId, {
      tools: new Map(tools.map((tool) => [tool.name, tool])),
      closed: false,
      notifications: [],
      bytes: 0,
    });
  }
  handle(message: HostMessage): void {
    if (message.type === "cell/closed") this.cancelCell(message.cellId, false);
    else if (message.type === "delegate/cancel") this.cancel(message.id);
    else if (message.type === "delegate/request") {
      if (this.pending.has(message.id)) throw new Error("Duplicate Code Mode delegate id");
      if (this.inFlight >= 256) throw new Error("Code Mode pending delegate limit exceeded");
      // Count even cancelled dispatches until their promises settle: a misbehaving
      // dispatcher must not accumulate unlimited unresolved continuations.
      this.inFlight++;
      void this.invoke(message).finally(() => {
        this.inFlight--;
      });
    }
  }
  private cancel(id: number): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.controller.abort();
  }
  cancelCell(cellId: string, terminateShells: boolean): void {
    const cell = this.cells.get(cellId);
    if (cell) cell.closed = true;
    for (const [id, pending] of this.pending) if (pending.cellId === cellId) this.cancel(id);
    if (terminateShells)
      for (const [id, owner] of this.shells) {
        if (owner === cellId) {
          this.shells.delete(id);
          this.options.shells?.terminateSession(id);
        }
      }
  }
  attach(response: RuntimeResponse): RuntimeResponse {
    const cell = this.cells.get(response.cellId);
    const notifications = cell?.notifications ?? [];
    if (cell) {
      cell.notifications = [];
      cell.bytes = 0;
    }
    if (response.kind !== "yielded") {
      this.cancelCell(response.cellId, response.kind === "terminated");
      this.cells.delete(response.cellId);
    }
    return {
      ...response,
      contentItems: [
        ...notifications.map((text) => ({ type: "input_text" as const, text })),
        ...response.contentItems,
      ],
    };
  }
  clear(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of this.pending.keys()) this.cancel(id);
    for (const id of this.shells.keys()) this.options.shells?.terminateSession(id);
    this.shells.clear();
    this.cells.clear();
    this.unsubscribe?.();
  }
  private async invoke(message: DelegateRequestMessage): Promise<void> {
    const request = message.request;
    const cellId =
      request.type === "notification/send" ? request.cellId : request.invocation.cell_id;
    const cell = this.cells.get(cellId);
    const controller = new AbortController();
    const pending = { cellId, controller };
    this.pending.set(message.id, pending);
    let result: HostResult;
    try {
      if (!cell || cell.closed || this.stopped) throw new Error("Code Mode cell is unavailable");
      if (request.type === "notification/send") {
        const bytes = Buffer.byteLength(request.text);
        if (cell.bytes + bytes > 1024 * 1024 || cell.notifications.length >= 256) {
          this.options.fail(new Error("Code Mode notification output limit exceeded"));
          return;
        }
        cell.notifications.push(request.text);
        cell.bytes += bytes;
        this.options.onNotification?.(`${this.options.cellPrefix}${cellId}`, request.text);
        result = { status: "ok", value: { type: "notification/delivered" } };
      } else {
        const invocation = request.invocation;
        const tool =
          invocation.tool_name.namespace !== undefined
            ? undefined
            : cell.tools.get(invocation.tool_name.name);
        if (!tool || tool.kind !== invocation.tool_kind)
          throw new Error(`Unknown Code Mode tool: ${invocation.tool_name.name}`);
        const value = await tool.invoke(invocation.input, {
          cellId: `${this.options.cellPrefix}${cellId}`,
          callId: `${this.options.cellPrefix}${cellId}:${invocation.runtime_tool_call_id}`,
          signal: controller.signal,
          ownShell: (id) => {
            if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid shell session ID");
            if (this.shells.has(id) && this.shells.get(id) !== cellId)
              throw new Error("Shell already belongs to another cell");
            if (controller.signal.aborted || cell.closed || this.stopped) {
              this.options.shells?.terminateSession(id);
              throw new Error("Code Mode shell owner is cancelled");
            }
            if (!this.options.shells) throw new Error("Code Mode shell ownership is unavailable");
            if (!this.shells.has(id) && this.shells.size >= 256) {
              this.options.shells.terminateSession(id);
              throw new Error("Code Mode owned shell limit exceeded");
            }
            this.shells.set(id, cellId);
          },
        });
        result = { status: "ok", value: { type: "tool/result", result: value ?? null } };
      }
    } catch (error) {
      result = {
        status: "error",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 16_384),
      };
    }
    // Cancellation removes ownership before aborting; late replies cannot revive a cell.
    if (this.pending.get(message.id) !== pending) return;
    this.pending.delete(message.id);
    try {
      this.options.send({ type: "delegate/response", id: message.id, result });
    } catch (error) {
      this.options.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
