import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  TAU_HEARTBEAT_INTERVAL_MS,
  TAU_READER_STALE_AFTER_MS,
  buildTauStatusPayload,
  fallbackTauSessionTitle,
  generateTauSessionTitle,
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

test("Tau status runtime records last message metadata", async () => {
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
  await runtime.recordEvent("idle", { lastMessage: "Done wiring Tau last messages" });

  expect(writes[1]).toMatchObject({
    status: "idle",
    lastMessage: "Done wiring Tau last messages",
    heartbeatAt: 1_700_000_005_000,
    lastEventAt: 1_700_000_005_000,
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

test("Tau title generation sanitizes model output and falls back without live calls", async () => {
  await expect(
    generateTauSessionTitle("@packages/tau/status.ts add session titles", {
      model: "test/title-model",
      runPi: async (args) => {
        expect(args).toContain("test/title-model");
        expect(args).toContain("--no-tools");
        return "Status title support\nextra explanation";
      },
    }),
  ).resolves.toBe("Status title support");

  await expect(
    generateTauSessionTitle("@packages/tau/status.ts add session titles", {
      runPi: async () => {
        throw new Error("no model");
      },
      onFallback: () => undefined,
    }),
  ).resolves.toBe("status.ts add session titles");

  expect(fallbackTauSessionTitle("hello")).toBe("hello");
  expect(
    fallbackTauSessionTitle(
      "I added session title generation in @packages/tau/index.ts I want this session title to be shown in @packages/tau/dashboard.ts",
    ),
  ).toBe("Show session title in dashboard.ts");
});

test("Tau status handlers publish generated title in the background", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const writes: unknown[] = [];
  let resolveTitle: (title: string) => void = () => {};
  const titleGenerated = new Promise<string>((resolve) => {
    resolveTitle = resolve;
  });
  const runtime = createTauStatusRuntime({
    pid: 1234,
    heartbeatIntervalMs: 20_000,
    writeSidecar: async (payload) => {
      writes.push({ ...payload });
    },
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    events: { on: () => undefined },
  };

  registerTauStatusHandlers(pi as never, runtime, {
    generateTitle: () => titleGenerated,
  });

  await handlers.get("session_start")?.(undefined, {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });
  vi.setSystemTime(1_700_000_005_000);
  const beforeAgentResult = handlers.get("before_agent_start")?.({
    prompt: "@packages/tau/status.ts add titles",
  });
  expect(beforeAgentResult).toBeUndefined();
  vi.setSystemTime(1_700_000_010_000);
  await handlers.get("agent_start")?.();

  expect(writes).toHaveLength(3);
  expect(writes[2]).toMatchObject({
    status: "working",
    lastMessage: "@packages/tau/status.ts add titles",
    lastEventAt: 1_700_000_010_000,
  });
  expect(writes[2]).not.toHaveProperty("title");

  vi.setSystemTime(1_700_000_015_000);
  resolveTitle("status.ts add titles");
  await vi.advanceTimersByTimeAsync(0);
  await handlers.get("before_agent_start")?.({ prompt: "second message" });

  expect(writes).toHaveLength(5);
  expect(writes[3]).toMatchObject({
    status: "working",
    title: "status.ts add titles",
    lastEventAt: 1_700_000_015_000,
  });
  expect(writes[4]).toMatchObject({
    status: "working",
    lastMessage: "second message",
    lastEventAt: 1_700_000_015_000,
  });

  await runtime.stop();
});

test("Tau status handlers save generated title to the session status.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-title-"));
  const paths = deriveTauStatusPaths("session-123", root);
  const runtime = createTauStatusRuntime({
    pid: 1234,
    now: () => 1_700_000_000_000,
    writeSidecar: (payload) => writeTauStatusSidecar(payload, paths),
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    events: { on: () => undefined },
  };

  registerTauStatusHandlers(pi as never, runtime, {
    generateTitle: async () => "status.json title persistence",
  });

  await handlers.get("session_start")?.(undefined, {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    },
  });
  handlers.get("before_agent_start")?.({ prompt: "demo title persistence" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(JSON.parse(readFileSync(paths.statusFile, "utf-8"))).toMatchObject({
    sessionId: "session-123",
    title: "status.json title persistence",
  });

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
    events: { on: () => undefined },
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

test("Tau status handlers surface and clear bash blockers during active work", async () => {
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
  const eventHandlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(event, handler);
    },
    events: {
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
        eventHandlers.set(event, handler);
      },
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
  await eventHandlers.get("bites:bash_gate")?.({ cwd: "/repo", command: "rm -rf dist" });
  vi.setSystemTime(1_700_000_007_000);
  await eventHandlers.get("bites:bash_gate_resolved")?.({ cwd: "/repo", command: "rm -rf dist" });

  expect(writes[2]).toMatchObject({
    status: "blocked",
    currentAction: "Approve rm -rf dist",
    currentTool: "bash",
    lastEventAt: 1_700_000_006_000,
  });
  expect(writes[3]).toMatchObject({
    status: "working",
    lastEventAt: 1_700_000_007_000,
  });
  expect(writes[3]).not.toHaveProperty("currentAction");
  expect(writes[3]).not.toHaveProperty("currentTool");

  await runtime.stop();
});

test("Tau status handlers derive blocker state from active blockers and agent work", async () => {
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
  const eventHandlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(event, handler);
    },
    events: {
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
        eventHandlers.set(event, handler);
      },
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
  await eventHandlers.get("bites:bash_gate")?.({ cwd: "/repo", command: "rm a" });
  await handlers.get("agent_start")?.();
  await eventHandlers.get("bites:bash_gate")?.({ cwd: "/repo", command: "rm b" });
  await eventHandlers.get("bites:bash_gate_resolved")?.({ cwd: "/repo", command: "rm a" });
  await eventHandlers.get("bites:bash_gate_resolved")?.({ cwd: "/repo", command: "rm b" });
  await handlers.get("agent_end")?.({ messages: [] });
  await handlers.get("agent_start")?.();
  await eventHandlers.get("bites:bash_gate")?.({ cwd: "/repo", command: "rm c" });
  await handlers.get("agent_end")?.({ messages: [] });
  await eventHandlers.get("bites:bash_gate_resolved")?.({ cwd: "/repo", command: "rm c" });

  expect(writes.map((write) => (write as { status: string }).status)).toEqual([
    "idle",
    "blocked",
    "blocked",
    "blocked",
    "blocked",
    "working",
    "idle",
    "working",
    "blocked",
    "blocked",
    "idle",
  ]);

  await runtime.stop();
});

test("Tau status handlers publish assistant response as last message", async () => {
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
    events: { on: () => undefined },
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
  await handlers.get("agent_end")?.({
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Implemented Tau last messages" }] },
    ],
  });

  expect(writes[1]).toMatchObject({
    status: "idle",
    lastMessage: "Implemented Tau last messages",
    lastEventAt: 1_700_000_005_000,
  });

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
    events: { on: () => undefined },
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
