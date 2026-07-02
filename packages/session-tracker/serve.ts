import {
  defaultSessionTrackerDaemonOptions,
  defaultSessionTrackerOptions,
  getTrackerSocketPath,
  SessionTracker,
  startSessionTrackerDaemon,
} from "./index.ts";

await startSessionTrackerDaemon(
  getTrackerSocketPath(),
  new SessionTracker(defaultSessionTrackerOptions),
  defaultSessionTrackerDaemonOptions,
);
