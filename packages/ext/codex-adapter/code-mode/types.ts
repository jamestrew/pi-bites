export type RuntimeContentItem =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail?: "auto" | "low" | "high" | "original" | null;
    };

export interface RuntimeResponse {
  kind: "yielded" | "result" | "terminated";
  cellId: string;
  contentItems: RuntimeContentItem[];
  errorText?: string;
  missingCell?: boolean;
  maxOutputTokens?: number;
}

/** Stable, cell-owned dependencies only. Never put a Pi ExtensionContext here. */
export interface DelegateCall {
  cellId: string;
  callId: string;
  signal: AbortSignal;
  /** Register a resumable shell immediately when its id is known, including partial updates.
   * After cancellation registration terminates the shell and throws. */
  ownShell(sessionId: number): void;
}

export interface RuntimeTool {
  name: string;
  description: string;
  kind: "function" | "freeform";
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Dispatcher validates arguments, authorizes launches, and rechecks signal after approval. */
  invoke(input: unknown, call: DelegateCall): Promise<unknown>;
}
