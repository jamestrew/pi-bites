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
