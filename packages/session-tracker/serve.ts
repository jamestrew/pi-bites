import {
  defaultSessionTrackerDaemonOptions,
  defaultSessionTrackerOptions,
  getTrackerSocketPath,
  SessionTracker,
  startSessionTrackerDaemon,
} from "./index.ts";

try {
  await startSessionTrackerDaemon(
    getTrackerSocketPath(),
    new SessionTracker(defaultSessionTrackerOptions),
    defaultSessionTrackerDaemonOptions,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
}
