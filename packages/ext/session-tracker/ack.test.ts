import { expect, test } from "vitest";
import registerSessionTracker, {
  createSessionTrackerRuntime,
  defaultTrackerRuntimeOptions,
} from "./index.js";

test("only needs-input can be acknowledged and heartbeats keep the resulting state", async () => {
  const states: string[] = [];
  let heartbeat: (() => void) | undefined;
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock",
    paneId: "%1",
    send: async (_socketPath, request) => {
      if ("record" in request) states.push(request.record.state);
      return { ok: true };
    },
    setInterval: ((callback: () => void) => {
      heartbeat = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  await runtime.start({ cwd: "/repo" });
  for (const state of ["idle", "working", "needs-permission", "needs-input"] as const) {
    if (state !== "idle") await runtime.setState(state);
    await runtime.acknowledgeNeedsInput();
    heartbeat?.();
    await Promise.resolve();
  }

  expect(states).toEqual([
    "idle",
    "idle",
    "working",
    "working",
    "needs-permission",
    "needs-permission",
    "needs-input",
    "idle",
    "idle",
  ]);
});

test("registers the pi-sessions acknowledgement command", () => {
  const commands: string[] = [];
  registerSessionTracker({
    on() {},
    events: { on() {} },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerShortcut() {},
  } as never);

  expect(commands).toContain("pi-sessions-ack");
});
