import { withApprovalDialog } from "./pending.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function exportBlockedCommand(command: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-bash-gate-${process.pid}-`));
  const path = join(directory, "blocked-command.sh");
  await writeFile(path, `${command}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

interface AutoModeEscalationOptions {
  pi: Pick<ExtensionAPI, "events">;
  ui: Pick<ExtensionContext["ui"], "select" | "notify">;
  cwd: string;
  command: string;
  toolName?: "bash" | "exec_command";
  rationale?: string;
  signal?: AbortSignal;
  isAllowed?: () => boolean;
  viewConversation?: () => Promise<void>;
  checkCurrent?: () => void;
}

export async function promptAutoModeEscalation({
  pi,
  ui,
  cwd,
  command,
  toolName,
  rationale,
  viewConversation,
  signal,
  isAllowed,
  checkCurrent,
}: AutoModeEscalationOptions): Promise<"allow" | "deny"> {
  return withApprovalDialog(pi.events, signal, async () => {
    checkCurrent?.();
    if (isAllowed?.()) return "allow";
    const waitId = randomUUID();
    pi.events.emit("bites:bash_gate", { cwd, command, toolName, requiresHuman: true, waitId });
    try {
      const prompt = `🤖 Automode denied this command${rationale ? `: ${rationale}` : "."}\n${command}`;

      for (;;) {
        const choice = await ui.select(
          prompt,
          [
            "Allow once",
            "Export command",
            ...(viewConversation ? ["View conversation"] : []),
            "Deny",
          ],
          ...(signal ? [{ signal }] : []),
        );
        signal?.throwIfAborted();
        checkCurrent?.();

        if (choice === "Allow once") return "allow";
        if (choice === "Export command") {
          try {
            ui.notify(await exportBlockedCommand(command), "info");
          } catch (error) {
            ui.notify(`Could not export command: ${String(error)}`, "error");
          }
          return "deny";
        }
        if (choice === "View conversation" && viewConversation) {
          await viewConversation();
          checkCurrent?.();
          continue;
        }
        return "deny";
      }
    } catch (error) {
      try {
        ui.notify(`Automode escalation failed closed: ${String(error)}`, "error");
      } catch {}
      return "deny";
    } finally {
      pi.events.emit("bites:bash_gate_resolved", {
        cwd,
        command,
        toolName,
        requiresHuman: true,
        waitId,
      });
    }
  });
}
