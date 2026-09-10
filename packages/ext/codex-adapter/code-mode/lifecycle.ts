import { CodeModeRuntime } from "./runtime.js";
import type { RuntimeOptions } from "./runtime.js";

export type InvalidationReason =
  | "session replacement"
  | "branch navigation"
  | "unsupported model"
  | "reload"
  | "shutdown";

export interface SessionSnapshot {
  readonly cwd: string;
  readonly sessionId: string;
}
interface SessionContext {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
}

/** Internal lifecycle hooks for #300. No tool/event registration occurs in this module.
 * Call sessionStart from session_start, branchChanged from successful session_tree,
 * modelSelected from model_select, and shutdown from session_shutdown (including reload).
 * Never rebuild from persisted transcript details or ordinary leaf growth.
 */
export class CodeModeLifecycle {
  private snapshot: SessionSnapshot | undefined;
  private supported = false;
  private runtime: CodeModeRuntime | undefined;

  constructor(
    private readonly options: (snapshot: SessionSnapshot) => RuntimeOptions,
    private readonly onInvalidated?: (reason: InvalidationReason) => void,
  ) {}

  sessionStart(ctx: SessionContext, supported: boolean): void {
    // Read every ephemeral getter synchronously; callbacks receive only frozen primitives.
    const snapshot = Object.freeze({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
    this.invalidate("session replacement");
    this.snapshot = snapshot;
    this.supported = supported;
  }
  modelSelected(supported: boolean): void {
    this.supported = supported;
    if (!supported) this.invalidate("unsupported model");
  }
  branchChanged(): void {
    this.invalidate("branch navigation");
  }
  shutdown(reason: "reload" | "shutdown" = "shutdown"): void {
    this.invalidate(reason);
    this.snapshot = undefined;
    this.supported = false;
  }
  /** A caller retains this generation for the entire operation, including yielded work. */
  current(): CodeModeRuntime {
    if (!this.snapshot || !this.supported)
      throw new Error("Code Mode is outside supported session/model scope");
    return (this.runtime ??= new CodeModeRuntime(this.options(this.snapshot)));
  }
  private invalidate(reason: InvalidationReason): void {
    const runtime = this.runtime;
    this.runtime = undefined;
    if (!runtime) return;
    void runtime.shutdown();
    this.onInvalidated?.(reason);
  }
}
