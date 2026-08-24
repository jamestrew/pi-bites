import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAutoModeOverride } from "../automode/index.js";

export async function exportBlockedCommand(command: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-bash-gate-${process.pid}-`));
  const path = join(directory, "blocked-command.sh");
  await writeFile(path, `${command}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

interface AutoModeEscalationOptions {
  pi: Pick<ExtensionAPI, "appendEntry" | "events">;
  ui: ExtensionContext["ui"];
  cwd: string;
  command: string;
  toolName?: "bash" | "exec_command";
  rationale?: string;
  viewConversation?: () => Promise<void>;
}

export async function promptAutoModeEscalation({
  pi,
  ui,
  cwd,
  command,
  toolName,
  rationale,
  viewConversation,
}: AutoModeEscalationOptions): Promise<"allow" | "deny"> {
  const waitId = randomUUID();
  pi.events.emit("bites:bash_gate", { cwd, command, toolName, requiresHuman: true, waitId });
  try {
    const prompt = `🤖 Automode denied this command${rationale ? `: ${rationale}` : "."}\n${command}`;

    for (;;) {
      const choice = await ui.select(prompt, [
        "Allow once",
        "Allow with reason…",
        "Export command",
        ...(viewConversation ? ["View conversation"] : []),
        "Deny",
      ]);

      if (choice === "Allow once") return "allow";
      if (choice === "Allow with reason…") {
        let reason = await ui.input("Why are you allowing this command?");
        while (reason !== undefined && reason.trim().length === 0) {
          reason = await ui.input("Reason is required", reason);
        }
        if (reason === undefined) continue;
        try {
          appendAutoModeOverride(pi, command, reason);
          return "allow";
        } catch (error) {
          ui.notify(`Could not remember Automode override: ${String(error)}`, "error");
          return "deny";
        }
      }
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
}
