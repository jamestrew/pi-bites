import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SHELL_AUTHORIZATION_ENTRY = "pi-bites:shell-authorization";

export type ShellAuthorizationStatus =
  | "not-reviewed"
  | "reviewer-approved"
  | "human-approved"
  | "blocked";

export interface ShellAuthorizationEntry {
  version: 1;
  toolCallId?: string;
  toolName: "bash" | "exec_command";
  command: string;
  status: ShellAuthorizationStatus;
}

export type ShellAuthorizationRequest = Omit<ShellAuthorizationEntry, "status">;
export type ShellAuthorizationDecision =
  | {
      outcome: "allow";
      authorization: Exclude<ShellAuthorizationStatus, "blocked">;
    }
  | { outcome: "block"; reason: string; terminate?: boolean };

export interface ShellAuthorizationTransaction {
  complete(
    decision: ShellAuthorizationDecision,
  ): { block: true; reason: string; terminate?: boolean } | undefined;
}

export function isShellAuthorizationEntry(value: unknown): value is ShellAuthorizationEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    (entry.toolCallId === undefined ||
      (typeof entry.toolCallId === "string" && entry.toolCallId.length > 0)) &&
    (entry.toolName === "bash" || entry.toolName === "exec_command") &&
    typeof entry.command === "string" &&
    (entry.status === "not-reviewed" ||
      entry.status === "reviewer-approved" ||
      entry.status === "human-approved" ||
      entry.status === "blocked")
  );
}

export function appendShellAuthorization(
  pi: Pick<ExtensionAPI, "appendEntry">,
  entry: ShellAuthorizationEntry,
): void {
  if (!isShellAuthorizationEntry(entry)) throw new Error("Invalid shell authorization entry");
  pi.appendEntry(SHELL_AUTHORIZATION_ENTRY, entry);
}

export class ShellAuthorizationTransactions {
  private sessionToken: object | undefined;
  private readonly pending = new Map<symbol, ShellAuthorizationRequest>();

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  sessionStarted(): void {
    this.sessionEnded();
    this.sessionToken = {};
  }

  sessionEnded(): void {
    for (const request of this.pending.values()) {
      appendShellAuthorization(this.pi, { ...request, status: "blocked" });
    }
    this.pending.clear();
    this.sessionToken = undefined;
  }

  begin(request: ShellAuthorizationRequest): ShellAuthorizationTransaction {
    const pendingToken = Symbol();
    const ownerSessionToken = this.sessionToken;
    let completed = false;
    this.pending.set(pendingToken, request);

    return {
      complete: (decision) => {
        if (completed) throw new Error("Shell authorization transaction already completed");
        completed = true;
        this.pending.delete(pendingToken);
        if (!ownerSessionToken || ownerSessionToken !== this.sessionToken) {
          return {
            block: true,
            reason: "Bash gate: owning session changed before authorization completed.",
          };
        }

        appendShellAuthorization(this.pi, {
          ...request,
          status: decision.outcome === "allow" ? decision.authorization : "blocked",
        });
        return decision.outcome === "block"
          ? {
              block: true,
              reason: decision.reason,
              ...(decision.terminate === undefined ? {} : { terminate: decision.terminate }),
            }
          : undefined;
      },
    };
  }
}
