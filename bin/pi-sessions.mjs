#!/usr/bin/env node

import { createConnection } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "usage: pi-sessions next [--from PANE_ID] [--client CLIENT_TTY]";

/** @typedef {{ type: "focus_next", currentPaneId?: string, targetClient?: string }} FocusNextRequest */
/** @typedef {{ ok: boolean, error?: string }} TrackerResponse */

/**
 * @param {string[]} args
 * @returns {FocusNextRequest}
 */
export function parseArgs(args) {
  if (args.shift() !== "next") throw new Error(usage);
  /** @type {FocusNextRequest} */
  const request = { type: "focus_next" };
  while (args.length > 0) {
    const option = args.shift();
    const value = args.shift();
    if (!value) throw new Error(usage);
    if (option === "--from") request.currentPaneId = value;
    else if (option === "--client") request.targetClient = value;
    else throw new Error(usage);
  }
  return request;
}

/**
 * @param {string} socketPath
 * @param {FocusNextRequest} request
 * @returns {Promise<TrackerResponse>}
 */
export function requestNext(socketPath, request) {
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
          ("error" in parsed && typeof parsed.error !== "string")
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

async function main() {
  const request = parseArgs(process.argv.slice(2));
  const socketPath = join(
    "/tmp",
    `pi-session-tracker-${process.getuid?.() ?? "default"}`,
    "session-tracker.sock",
  );
  const response = await requestNext(socketPath, request);
  if (!response.ok) throw new Error(response.error ?? "no tracked Pi panes");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `pi-sessions: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
