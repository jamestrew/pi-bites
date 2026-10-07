#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const usage =
  "usage: pi-sessions next [--from PANE_ID] [--client CLIENT_TTY] | pick [--client CLIENT_TTY]";
const statePriority = { "needs-permission": 0, "needs-input": 1, working: 2, idle: 3 };

/** @typedef {{ type: "focus_next", currentPaneId?: string, targetClient?: string }} FocusNextRequest */
/** @typedef {{ paneId: string, cwd: string, state: keyof typeof statePriority }} PaneRecord */
/** @typedef {{ type: "pick", targetClient?: string }} PickCommand */
/** @typedef {FocusNextRequest | { type: "snapshot" }} TrackerRequest */
/** @typedef {{ ok: boolean, error?: string, records?: PaneRecord[] }} TrackerResponse */

/**
 * @param {string[]} args
 * @returns {FocusNextRequest | PickCommand}
 */
export function parseArgs(args) {
  const command = args.shift();
  if (command !== "next" && command !== "pick") throw new Error(usage);
  /** @type {FocusNextRequest | PickCommand} */
  const request = { type: command === "next" ? "focus_next" : "pick" };
  while (args.length > 0) {
    const option = args.shift();
    const value = args.shift();
    if (!value) throw new Error(usage);
    if (option === "--from" && request.type === "focus_next") request.currentPaneId = value;
    else if (option === "--client") request.targetClient = value;
    else throw new Error(usage);
  }
  return request;
}

/**
 * @param {string} socketPath
 * @param {TrackerRequest} request
 * @returns {Promise<TrackerResponse>}
 */
export function requestTracker(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("session tracker timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.destroy();
      try {
        /** @type {unknown} */
        const parsed = JSON.parse(data.trim());
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("ok" in parsed) ||
          typeof parsed.ok !== "boolean" ||
          ("error" in parsed && typeof parsed.error !== "string") ||
          ("records" in parsed &&
            (!Array.isArray(parsed.records) || !parsed.records.every(isPaneRecord)))
        )
          throw new Error("invalid session tracker response");
        const response = /** @type {TrackerResponse} */ (parsed);
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => reject(new Error("session tracker closed without a response")));
  });
}

/** @param {unknown} value @returns {value is PaneRecord} */
function isPaneRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "paneId" in value &&
    typeof value.paneId === "string" &&
    /^%\d+$/.test(value.paneId) &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "state" in value &&
    typeof value.state === "string" &&
    Object.hasOwn(statePriority, value.state)
  );
}

/** @param {string} text */
function singleLine(text) {
  // Pane names and paths are display data, never terminal controls or extra rows.
  // oxlint-disable-next-line no-control-regex -- strip terminal controls from display data
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/**
 * @param {PaneRecord[]} records
 * @param {string | undefined} targetClient
 */
export function pickPane(records, targetClient) {
  const panes = new Map(
    execFileSync(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}\t#{session_id}:#{window_id}.#{pane_id}\t#{session_name}:#{window_index}:#{window_name}.#{pane_index}",
      ],
      { encoding: "utf8" },
    )
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [id, target, ...label] = line.split("\t");
        return [id ?? "", { target: target ?? "", label: singleLine(label.join(" ")) }];
      }),
  );
  const rows = [...records]
    .sort(
      (a, b) =>
        statePriority[a.state] - statePriority[b.state] ||
        a.cwd.localeCompare(b.cwd) ||
        a.paneId.localeCompare(b.paneId),
    )
    .flatMap((record) => {
      const pane = panes.get(record.paneId);
      return pane
        ? [
            `${record.paneId}\t${pane.target}\t${record.state.padEnd(16)}  ${pane.label}  ${singleLine(record.cwd)}  ${record.paneId}`,
          ]
        : [];
    });
  if (rows.length === 0) throw new Error("no tracked Pi panes in this tmux server");
  const result = spawnSync(
    "fzf",
    [
      "--no-multi",
      "--no-sort",
      "--layout=reverse",
      "--delimiter=\t",
      "--with-nth=3..",
      "--prompt=Pi sessions> ",
      "--header=Enter: focus · Ctrl-U/D: scroll preview · Ctrl-R: refresh · Esc: cancel",
      "--preview=tmux capture-pane -e -p -t {1}",
      "--preview-window=right,60%,nowrap,follow",
      "--bind=ctrl-d:preview-half-page-down,ctrl-u:preview-half-page-up,ctrl-r:refresh-preview",
    ],
    {
      input: `${rows.join("\n")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      // This widget owns fzf's input/output protocol and key bindings.
      env: { ...process.env, FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "" },
    },
  );
  if (result.error) throw result.error;
  if (result.status === 1 || result.status === 130) return; // No match or cancelled.
  if (result.status !== 0) throw new Error(`fzf failed (${result.signal ?? result.status})`);
  const selected = result.stdout.trimEnd();
  if (!rows.includes(selected)) throw new Error("invalid fzf selection");
  const [, target] = selected.split("\t");
  if (!target) throw new Error("invalid fzf selection");
  // Keep the displayed session/window even when the pane's window is linked.
  // Focus through the popup's tmux server, not the host-wide daemon's server.
  execFileSync(
    "tmux",
    ["switch-client", ...(targetClient ? ["-c", targetClient] : []), "-t", target],
    { stdio: "inherit" },
  );
}

async function main() {
  const command = parseArgs(process.argv.slice(2));
  const socketPath = join(
    "/tmp",
    `pi-session-tracker-${process.getuid?.() ?? "default"}`,
    "session-tracker.sock",
  );
  const response = await requestTracker(
    socketPath,
    command.type === "pick" ? { type: "snapshot" } : command,
  );
  if (!response.ok) throw new Error(response.error ?? "no tracked Pi panes");
  if (command.type === "pick") {
    if (!response.records) throw new Error("invalid session tracker snapshot");
    pickPane(response.records, command.targetClient);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `pi-sessions: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
