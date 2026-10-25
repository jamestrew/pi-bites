/** Offline resume/tree probe: bun scripts/tool-selection-cli-smoke.ts [PI_EXECUTABLE]. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAdapter from "../packages/ext/codex-adapter/index.js";
import { registerOfflineProvider } from "./native-codemode-cli-smoke.js";

export default function (pi: ExtensionAPI): void {
  registerOfflineProvider(pi, "gpt-6.1-sol");
  registerAdapter(pi, { current: {} });
  pi.registerCommand("selection-probe", {
    description: "Offline selection validation",
    async handler(args, ctx) {
      if (args.startsWith("tree ")) {
        await ctx.navigateTree(args.slice(5), { summarize: false });
        return; // Navigation invalidates ctx; inspect with a fresh command instead.
      }
      if (args === "disable")
        pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "codemode"));
      ctx.ui.notify(
        JSON.stringify({
          active: pi.getActiveTools(),
          leaf: ctx.sessionManager.getLeafId(),
          file: ctx.sessionManager.getSessionFile(),
        }),
        "info",
      );
    },
  });
}

if (import.meta.main) {
  const directory = mkdtempSync(join(tmpdir(), "pi-selection-cli-"));
  const executable = process.argv[2]?.includes("/")
    ? resolve(process.argv[2])
    : (process.argv[2] ?? "pi");
  function launch(sessionFile?: string) {
    const child = spawn(
      executable,
      [
        "--offline",
        "--mode",
        "rpc",
        "-nc",
        "-ns",
        "-np",
        "--no-themes",
        "-ne",
        "-e",
        fileURLToPath(import.meta.url),
        "--provider",
        "native-cli-smoke",
        "--model",
        "gpt-6.1-sol",
        ...(sessionFile ? ["--session", sessionFile] : []),
      ],
      {
        cwd: directory,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    async function next(): Promise<any> {
      for (;;) {
        const line = await lines.next();
        assert.ok(!line.done, `CLI exited before its response: ${stderr}`);
        if (line.value.startsWith("{")) return JSON.parse(line.value);
      }
    }
    let sequence = 0;
    async function prompt(message: string) {
      const id = String(++sequence);
      child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
      const events: any[] = [];
      for (;;) {
        const event = await next();
        events.push(event);
        if (event.type === "response" && event.id === id) {
          assert.equal(event.success, true, JSON.stringify(event));
          if (message.startsWith("/")) return events;
        }
        if (event.type === "agent_end") return events;
      }
    }
    return {
      prompt,
      async snapshot() {
        const events = await prompt("/selection-probe state");
        const notice = events.find(
          (e) => e.type === "extension_ui_request" && e.method === "notify",
        );
        assert.ok(notice, JSON.stringify(events));
        return JSON.parse(notice.message) as { active: string[]; leaf: string; file: string };
      },
      async close() {
        child.kill("SIGTERM");
        await exited;
      },
    };
  }
  let host: ReturnType<typeof launch> | undefined;
  function assertExecution(events: any[]) {
    const end = events.find((e) => e.type === "tool_execution_end" && e.toolName === "codemode");
    assert.ok(end && !end.isError, JSON.stringify(events));
    const output = end.result.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");
    assert.match(output, /Output:\s*42\s*$/);
  }
  try {
    host = launch();
    assertExecution(await host.prompt("persist the enabled branch"));
    const enabled = await host.snapshot();
    assert.ok(enabled.active.includes("codemode"));
    await host.prompt("/selection-probe disable");
    await host.prompt("persist the disabled branch");
    const disabled = await host.snapshot();
    assert.ok(!disabled.active.includes("codemode"));
    await host.close();

    host = launch(disabled.file);
    assert.ok(!(await host.snapshot()).active.includes("codemode"));
    await host.prompt(`/selection-probe tree ${enabled.leaf}`);
    assert.ok((await host.snapshot()).active.includes("codemode"));
    assertExecution(await host.prompt("execute on the restored enabled branch"));
    await host.prompt(`/selection-probe tree ${disabled.leaf}`);
    assert.ok(!(await host.snapshot()).active.includes("codemode"));
    console.log(
      "PASS: installed CLI resumes disabled codemode and restores both branch selections",
    );
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
