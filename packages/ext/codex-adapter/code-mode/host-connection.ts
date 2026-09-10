import type { HostLimits } from "./host-process.js";
import { CodeModeHostProcess } from "./host-process.js";
import { type HostMessage, parseHostMessage } from "./host-protocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onValue?: ((value: unknown) => void) | undefined;
  timer?: ReturnType<typeof setTimeout>;
};

type HostConnectionOptions = {
  limits?: HostLimits;
  binary: string;
  onMessage: (message: HostMessage) => void;
  onFailure: (error: Error) => void;
};

export class CodeModeHostConnection {
  private readonly process: CodeModeHostProcess;
  private readonly onMessage: (message: HostMessage) => void;
  private readonly onFailure: (error: Error) => void;
  private requestId = 0;
  private readonly startupTimeoutMs: number;
  private failure: Error | undefined;
  private closing: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;
  private pending = new Map<number, Pending>();
  private initial = new Map<number, Pending>();

  constructor(options: HostConnectionOptions) {
    this.onMessage = options.onMessage;
    this.startupTimeoutMs = options.limits?.startupTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.startupTimeoutMs) ||
      this.startupTimeoutMs <= 0 ||
      this.startupTimeoutMs > 2_147_483_647
    )
      throw new Error("Invalid Code Mode startup timeout");
    this.onFailure = options.onFailure;
    this.process = new CodeModeHostProcess({
      binary: options.binary,
      limits: options.limits,
      onMessage: (message) => this.handleMessage(parseHostMessage(message)),
      onFailure: (error) => this.failAll(error),
    });
  }

  nextRequestId(): number {
    return ++this.requestId;
  }

  async start(sessionId: string): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ready) return this.ready;
    const ready = this.startProcess(sessionId);
    this.ready = ready;
    try {
      await ready;
    } catch (error) {
      throw this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async startProcess(sessionId: string): Promise<void> {
    await this.process.start();
    if (this.failure) throw this.failure;
    const handshake = new Promise<void>((resolve, reject) => {
      this.pending.set(0, { resolve: () => resolve(), reject });
    });
    // A synchronous stdin failure can occur before the await below (notably on Bun).
    // Its handshake promise is still owned and will be rejected by failAll.
    void handshake.catch(() => {});
    this.send({
      type: "connection/hello",
      supportedVersions: [1],
      requiredCapabilities: [],
      optionalCapabilities: [],
    });
    const timer = setTimeout(
      () => this.failAll(new Error("Code-mode host startup timed out")),
      this.startupTimeoutMs,
    );
    try {
      await handshake;
      const response = await this.request({ method: "session/open", sessionId });
      if (
        !response ||
        typeof response !== "object" ||
        !("type" in response) ||
        response.type !== "session/ready" ||
        !("sessionId" in response) ||
        response.sessionId !== sessionId
      )
        throw new Error("Invalid Code Mode session handshake");
    } finally {
      clearTimeout(timer);
    }
  }

  request(request: Record<string, unknown>, onValue?: (value: unknown) => void): Promise<unknown> {
    return this.requestWithId(this.nextRequestId(), request, onValue);
  }

  requestWithId(
    id: number,
    request: Record<string, unknown>,
    onValue?: (value: unknown) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      if (this.pending.size >= 256) {
        reject(new Error("Code-mode pending operation limit exceeded"));
        return;
      }
      const timer =
        request.method === "session/wait" || request.method === "session/open"
          ? undefined
          : setTimeout(
              () =>
                this.failAll(
                  new Error(`Code Mode ${String(request.method)} acknowledgement timed out`),
                ),
              5_000,
            );
      this.pending.set(id, { resolve, reject, onValue, timer });
      try {
        this.send({ type: "operation/request", id, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  expectInitial(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.initial.set(id, { resolve, reject });
    });
  }

  send(message: unknown): void {
    this.process.send(message);
  }

  rejectOperation(id: number, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    clearTimeout(pending?.timer);
    pending?.reject(error);
    const initial = this.initial.get(id);
    this.initial.delete(id);
    initial?.reject(error);
  }

  close(error: Error): Promise<void> {
    this.failAll(error);
    return this.closing;
  }

  private handleMessage(message: HostMessage): void {
    if (message.type === "connection/ready") {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.resolve(undefined);
      return;
    }
    if (message.type === "connection/rejected") {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.reject(new Error(`Code-mode handshake rejected: ${JSON.stringify(message.reason)}`));
      return;
    }
    if (message.type === "operation/response") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (message.result.status === "error") {
        pending.reject(new Error(message.result.message));
        return;
      }
      const value = message.result.value;
      try {
        pending.onValue?.(value);
        pending.resolve(value);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return;
    }
    if (message.type === "execute/initialResponse") {
      const pending = this.initial.get(message.id);
      this.initial.delete(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (message.result.status === "error") pending.reject(new Error(message.result.message));
      else pending.resolve(message.result.value);
      return;
    }
    this.onMessage(message);
  }

  private failAll(error: Error): Error {
    if (this.failure) return this.failure;
    this.failure = new Error(
      `${error.message}. Code Mode is unavailable; check the host installation and run /reload, or explicitly disable codexAdapter.`,
    );
    error = this.failure;
    for (const pending of [...this.pending.values(), ...this.initial.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.initial.clear();
    this.ready = undefined;
    this.closing = this.process.kill();
    this.onFailure(error);
    return error;
  }
}
