import {
  defaultSessionTrackerDaemonOptions,
  codeOf,
  defaultSessionTrackerOptions,
  getTrackerSocketPath,
  SessionTracker,
  startSessionTrackerDaemon,
  writeSessionTrackerLog,
} from "./index.ts";

const socketPath = getTrackerSocketPath();
writeSessionTrackerLog(socketPath, "serve starting");

try {
  await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker(defaultSessionTrackerOptions),
    defaultSessionTrackerDaemonOptions,
  );
} catch (error) {
  if (codeOf(error) === "EADDRINUSE") {
    writeSessionTrackerLog(socketPath, "serve exiting: daemon already running");
  } else {
    writeSessionTrackerLog(socketPath, "serve failed", error);
    throw error;
  }
}
