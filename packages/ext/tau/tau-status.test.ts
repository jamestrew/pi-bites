import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  TAU_HEARTBEAT_INTERVAL_MS,
  TAU_READER_STALE_AFTER_MS,
  buildTauStatusPayload,
  createTauStatusRuntime,
  deriveTauStatusPaths,
  publishTauStatusForSession,
  registerTauStatusHandlers,
  writeTauStatusSidecar,
} from "./index.js";

afterEach(() => {
  vi.useRealTimers();
});

test("buildTauStatusPayload creates the initial idle Tau status shape", () => {
  expect(
    buildTauStatusPayload({
      sessionId: "session-123",
      sessionFile: "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
      cwd: "/repo",
      pid: 1234,
      ppid: 567,
      now: 1_700_000_000_000,
    }),
  ).toEqual({
    schemaVersion: 1,
    sessionId: "session-123",
    sessionFile: "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    cwd: "/repo",
    pid: 1234,
    ppid: 567,
    startedAt: 1_700_000_000_000,
    heartbeatAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    status: "idle",
  });
});

test("Tau heartbeat cadence documents reader stale expectations", () => {
  expect(TAU_HEARTBEAT_INTERVAL_MS).toBe(20_000);
  expect(TAU_READER_STALE_AFTER_MS).toBeGreaterThanOrEqual(TAU_HEARTBEAT_INTERVAL_MS * 3);
});

test("deriveTauStatusPaths places status under the pi-agents session directory", () => {
  expect(deriveTauStatusPaths("session-123", "/home/me/.pi/agents")).toEqual({
    directory: "/home/me/.pi/agents/sessions/session-123",
    statusFile: "/home/me/.pi/agents/sessions/session-123/status.json",
  });
});

test("writeTauStatusSidecar creates missing directories and only writes status.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-status-"));
  const paths = deriveTauStatusPaths("session-123", root);
  const sessionJsonl = join(root, "canonical-session.jsonl");
  const payload = buildTauStatusPayload({
    sessionId: "session-123",
    sessionFile: sessionJsonl,
    cwd: "/repo",
    pid: 1234,
    now: 1_700_000_000_000,
  });

  await writeTauStatusSidecar(payload, paths);

  expect(existsSync(paths.directory)).toBe(true);
  expect(readdirSync(paths.directory)).toEqual(["status.json"]);
  expect(JSON.parse(readFileSync(paths.statusFile, "utf-8"))).toEqual(payload);
  expect(existsSync(sessionJsonl)).toBe(false);
});

test("Tau status runtime refreshes heartbeat without activity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });

  await runtime.start({
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });

  await vi.advanceTimersByTimeAsync(20_000);

  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({
    status: "idle",
    startedAt: 1_700_000_000_000,
    heartbeatAt: 1_700_000_020_000,
    lastEventAt: 1_700_000_000_000,
  });

  await runtime.stop();
});

test("Tau status runtime records agent turns as working then idle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });

  await runtime.start({
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });

  vi.setSystemTime(1_700_000_005_000);
  await runtime.recordEvent("working");
  vi.setSystemTime(1_700_000_010_000);
  await runtime.recordEvent("idle");
  await vi.advanceTimersByTimeAsync(20_000);

  expect(writes).toHaveLength(4);
  expect(writes[1]).toMatchObject({
    status: "working",
    heartbeatAt: 1_700_000_005_000,
    lastEventAt: 1_700_000_005_000,
  });
  expect(writes[2]).toMatchObject({
    status: "idle",
    heartbeatAt: 1_700_000_010_000,
    lastEventAt: 1_700_000_010_000,
  });
  expect(writes[3]).toMatchObject({
    status: "idle",
    heartbeatAt: 1_700_000_030_000,
    lastEventAt: 1_700_000_010_000,
  });

  await runtime.stop();
});

test("Tau status runtime records and clears current activity metadata", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });

  await runtime.start({
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });

  vi.setSystemTime(1_700_000_005_000);
  await runtime.recordEvent("working", { currentAction: "Running bun test", currentTool: "bash" });
  vi.setSystemTime(1_700_000_010_000);
  await runtime.recordEvent("idle", { currentAction: undefined, currentTool: undefined });

  expect(writes[1]).toMatchObject({
    status: "working",
    currentAction: "Running bun test",
    currentTool: "bash",
    heartbeatAt: 1_700_000_005_000,
    lastEventAt: 1_700_000_005_000,
  });
  expect(writes[2]).toMatchObject({
    status: "idle",
    heartbeatAt: 1_700_000_010_000,
    lastEventAt: 1_700_000_010_000,
  });
  expect(writes[2]).not.toHaveProperty("currentAction");
  expect(writes[2]).not.toHaveProperty("currentTool");

  await runtime.stop();
});

test("Tau status handlers track overlapping tool activity predictably", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(event, handler);
    },
  };

  registerTauStatusHandlers(pi as never, runtime);

  await handlers.get("session_start")?.(undefined, {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });
  vi.setSystemTime(1_700_000_005_000);
  await handlers.get("agent_start")?.();
  vi.setSystemTime(1_700_000_006_000);
  await handlers.get("tool_call")?.({
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "bun test" },
  });
  vi.setSystemTime(1_700_000_007_000);
  await handlers.get("tool_call")?.({
    toolCallId: "tool-2",
    toolName: "read",
    input: { path: "README.md" },
  });
  vi.setSystemTime(1_700_000_008_000);
  await handlers.get("tool_result")?.({ toolCallId: "tool-2" });
  vi.setSystemTime(1_700_000_009_000);
  await handlers.get("tool_result")?.({ toolCallId: "tool-1" });

  expect(writes[2]).toMatchObject({
    status: "working",
    currentAction: "Running bun test",
    currentTool: "bash",
    lastEventAt: 1_700_000_006_000,
  });
  expect(writes[3]).toMatchObject({
    status: "working",
    currentAction: "Running read",
    currentTool: "read",
    lastEventAt: 1_700_000_007_000,
  });
  expect(writes[4]).toMatchObject({
    status: "working",
    currentAction: "Running bun test",
    currentTool: "bash",
    lastEventAt: 1_700_000_008_000,
  });
  expect(writes[5]).toMatchObject({
    status: "working",
    lastEventAt: 1_700_000_009_000,
  });
  expect(writes[5]).not.toHaveProperty("currentAction");
  expect(writes[5]).not.toHaveProperty("currentTool");

  await runtime.stop();
});

test("Tau status handlers keep agent runs working until agent_end", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(event, handler);
    },
  };

  registerTauStatusHandlers(pi as never, runtime);

  await handlers.get("session_start")?.(undefined, {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });
  vi.setSystemTime(1_700_000_005_000);
  await handlers.get("agent_start")?.();
  vi.setSystemTime(1_700_000_010_000);
  await handlers.get("turn_end")?.();
  vi.setSystemTime(1_700_000_015_000);
  await handlers.get("agent_end")?.();

  expect(writes).toHaveLength(3);
  expect(writes[1]).toMatchObject({
    status: "working",
    heartbeatAt: 1_700_000_005_000,
    lastEventAt: 1_700_000_005_000,
  });
  expect(writes[2]).toMatchObject({
    status: "idle",
    heartbeatAt: 1_700_000_015_000,
    lastEventAt: 1_700_000_015_000,
  });

  await runtime.stop();
});

test("Tau status runtime writes stopped status and clears heartbeat on shutdown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });

  await runtime.start({
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });

  vi.setSystemTime(1_700_000_005_000);
  await runtime.recordEvent("working");
  vi.setSystemTime(1_700_000_010_000);
  await runtime.stop();
  vi.setSystemTime(1_700_000_030_000);
  await vi.advanceTimersByTimeAsync(20_000);

  expect(writes).toHaveLength(3);
  expect(writes[1]).toMatchObject({
    status: "working",
    heartbeatAt: 1_700_000_005_000,
    lastEventAt: 1_700_000_005_000,
  });
  expect(writes[2]).toMatchObject({
    status: "stopped",
    heartbeatAt: 1_700_000_010_000,
    lastEventAt: 1_700_000_010_000,
  });
});

test("Tau status runtime serializes heartbeat and shutdown writes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  let writeCount = 0;
  let releaseHeartbeat: () => void = () => {};
  const heartbeatWrite = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writeCount += 1;
      if (writeCount === 2) await heartbeatWrite;
      writes.push({ ...payload });
    },
  });

  await runtime.start({
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });

  await vi.advanceTimersByTimeAsync(20_000);
  vi.setSystemTime(1_700_000_021_000);
  const stop = runtime.stop();
  await vi.advanceTimersByTimeAsync(0);

  expect(writes).toHaveLength(1);

  releaseHeartbeat();
  await stop;

  expect(writes).toHaveLength(3);
  expect(writes[1]).toMatchObject({ status: "idle", heartbeatAt: 1_700_000_020_000 });
  expect(writes[2]).toMatchObject({ status: "stopped", heartbeatAt: 1_700_000_021_000 });
});

test("publishTauStatusForSession reports write failures without throwing", async () => {
  const errors: unknown[] = [];

  await expect(
    publishTauStatusForSession(
      {
        cwd: "/repo",
        sessionManager: {
          getSessionId: () => "session-123",
          getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
        },
      },
      {
        pid: 1234,
        now: () => 1_700_000_000_000,
        writeSidecar: async () => {
          throw new Error("permission denied");
        },
        onError: (error) => errors.push(error),
      },
    ),
  ).resolves.toBeUndefined();

  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("permission denied");
});
