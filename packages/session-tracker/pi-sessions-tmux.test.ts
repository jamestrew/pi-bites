import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";

const nativeToolsAvailable =
  process.platform === "linux" &&
  [
    ["tmux", "-V"],
    ["fzf", "--version"],
    ["script", "--version"],
  ].every(([command, flag]) => spawnSync(command!, [flag!]).status === 0);

test.skipIf(!nativeToolsAvailable)(
  "Enter in the documented popup binding focuses the invoking client",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-picker-test-"));
    const socketName = `pi-picker-${randomUUID()}`;
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-L", socketName, ...args], {
        encoding: "utf8",
        env: { ...process.env, FZF_DEFAULT_OPTS: "--print-query", FZF_DEFAULT_OPTS_FILE: "" },
      });
    const scriptPath = join(dir, "picker.mjs");
    const cliUrl = new URL("../../bin/pi-sessions.mjs", import.meta.url).href;
    writeFileSync(
      scriptPath,
      `import { parseArgs, pickPane } from ${JSON.stringify(cliUrl)};
const command = parseArgs(process.argv.slice(2));
pickPane([{paneId: "%1", cwd: "/target", state: "idle"}], command.targetClient);
`,
    );
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const binding = readme.split("\n").find((line) => line.includes('pick --client \\"'));
    expect(binding).toBeDefined();
    writeFileSync(
      join(dir, "tmux.conf"),
      `${binding!.replace("bind-key -n M-s", "bind-key s").replace("/path/to/pi-bites/bin/pi-sessions.mjs", scriptPath)}\n`,
    );
    let client: ReturnType<typeof spawn> | undefined;
    try {
      tmux("-f", "/dev/null", "new-session", "-d", "-s", "source");
      tmux("new-session", "-d", "-s", "target");
      tmux("link-window", "-s", "target:0", "-t", "source:1");
      tmux("set-environment", "-t", "source", "FZF_DEFAULT_OPTS", "--print-query");
      tmux("source-file", join(dir, "tmux.conf"));
      // util-linux script supplies a real client tty while keeping this test unattended.
      client = spawn("script", ["-qefc", `tmux -L ${socketName} attach -t source`, "/dev/null"], {
        env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      client.stdout!.on("data", (chunk) => {
        output += chunk.toString();
      });
      client.stderr!.on("data", (chunk) => {
        output += chunk.toString();
      });
      await vi.waitFor(() =>
        expect(tmux("list-clients", "-F", "#{session_name}").trim()).toBe("source"),
      );
      client.stdin!.write("\x02s");
      await vi.waitFor(() => expect(output).toContain("Pi sessions>"));
      client.stdin!.write("\r");
      await vi.waitFor(() =>
        expect(tmux("list-clients", "-F", "#{session_name} #{pane_id}").trim()).toBe("target %1"),
      );
    } finally {
      spawnSync("tmux", ["-L", socketName, "kill-server"]);
      client?.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
