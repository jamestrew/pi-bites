import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createForkTransfer, readForkTransfer } from "../fork-inheritance.js";
import goalExtension, { __testHooks } from "../index.js";
import { createThreadGoal, isThreadGoal, reconstructGoal } from "../state.js";
import { CUSTOM_ENTRY_TYPE } from "../types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistantMessage(
  model: Model<any>,
  usage = { input: 0, output: 0 },
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "error" ? [] : [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      ...usage,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "terminal provider failure" } : {}),
    timestamp: Date.now(),
  };
}

function response(model: Model<any>, message: AssistantMessage): ReturnType<StreamFunction> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push(
      message.stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: "stop", message },
    );
    stream.end();
  });
  return stream;
}

async function createForkRuntime(monotonicNow?: () => number) {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-fork-e2e-"));
  tempDirs.push(root);
  const cwd = join(root, "worktree");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider("fork-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Fork Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRuntime.getModel("fork-test", "model");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        noContextFiles: true,
        noExtensions: true,
        extensionFactories: [(pi) => goalExtension(pi, { monotonicNow })],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      noTools: "builtin",
    });
    await created.session.bindExtensions({ mode: "rpc" });
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

  return { root, cwd, sessionDir, model, createRuntime };
}

function seedPersistedSession(
  cwd: string,
  sessionDir: string,
  model: Model<any>,
): { manager: SessionManager; firstUserId: string; secondUserId: string } {
  const manager = SessionManager.create(cwd, sessionDir);
  const firstUserId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage(assistantMessage(model));
  const secondUserId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  assert.ok(manager.getSessionFile() && existsSync(manager.getSessionFile()!));
  return { manager, firstUserId, secondUserId };
}

async function executeGoalTool(
  session: Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"],
  name: "create_goal" | "get_goal" | "update_goal",
  params: Record<string, unknown>,
) {
  const tool = session.extensionRunner.getToolDefinition(name);
  assert.ok(tool);
  return tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
}

function countKind(manager: SessionManager, kind: string): number {
  return manager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        (entry.data as { kind?: unknown } | undefined)?.kind === kind,
    ).length;
}

describe("goal fork inheritance through Pi runtime", () => {
  test("selects by copied target when transfers share a timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-goal-transfer-selection-"));
    tempDirs.push(dir);
    const file = join(dir, "source.jsonl");
    const targetA = "target-a";
    const targetB = "target-b";
    const transferA = createForkTransfer(
      "source",
      "user-a",
      "before",
      targetA,
      createThreadGoal("goal A", null, 1),
      1,
    );
    const transferB = createForkTransfer(
      "source",
      "user-b",
      "before",
      targetB,
      createThreadGoal("goal B", null, 1),
      1,
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      file,
      [
        { type: "session", id: "source", version: 3, timestamp, cwd: "/tmp" },
        { type: "message", id: targetA, parentId: null, timestamp, message: { role: "assistant" } },
        {
          type: "message",
          id: targetB,
          parentId: targetA,
          timestamp,
          message: { role: "assistant" },
        },
        {
          type: "custom",
          id: "transfer-a",
          parentId: targetB,
          timestamp,
          customType: CUSTOM_ENTRY_TYPE,
          data: transferA,
        },
        {
          type: "custom",
          id: "transfer-b",
          parentId: "transfer-a",
          timestamp,
          customType: CUSTOM_ENTRY_TYPE,
          data: transferB,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const selected = readForkTransfer(
      SessionManager.open(file),
      [{ type: "message", id: targetA, message: { role: "assistant" } }],
      timestamp,
      isThreadGoal,
    );
    expect(selected.kind).toBe("found");
    expect(selected.kind === "found" ? selected.transfer.transferId : null).toBe(
      transferA.transferId,
    );

    const ambiguousFile = join(dir, "ambiguous.jsonl");
    const transferA2 = createForkTransfer(
      "source",
      "user-a-2",
      "before",
      targetA,
      createThreadGoal("goal A2", null, 1),
      1,
    );
    writeFileSync(
      ambiguousFile,
      [
        { type: "session", id: "source", version: 3, timestamp, cwd: "/tmp" },
        { type: "message", id: targetA, parentId: null, timestamp, message: { role: "assistant" } },
        {
          type: "custom",
          id: "transfer-a",
          parentId: targetA,
          timestamp,
          customType: CUSTOM_ENTRY_TYPE,
          data: transferA,
        },
        {
          type: "custom",
          id: "transfer-a-2",
          parentId: "transfer-a",
          timestamp,
          customType: CUSTOM_ENTRY_TYPE,
          data: transferA2,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    expect(
      readForkTransfer(
        SessionManager.open(ambiguousFile),
        [{ type: "message", id: targetA, message: { role: "assistant" } }],
        timestamp,
        isThreadGoal,
      ).kind,
    ).toBe("unsafe");

    const noGoalTransfer = createForkTransfer("source", "user-a", "at", targetA, null, 2);
    const fallbackFile = join(dir, "fallback.jsonl");
    writeFileSync(
      fallbackFile,
      [
        { type: "session", id: "source", version: 3, timestamp, cwd: "/tmp" },
        { type: "message", id: targetA, parentId: null, timestamp, message: { role: "assistant" } },
        {
          type: "custom",
          id: "old-goal-transfer",
          parentId: targetA,
          timestamp: "2026-01-01T00:00:01.000Z",
          customType: CUSTOM_ENTRY_TYPE,
          data: transferA,
        },
        {
          type: "custom",
          id: "no-goal-transfer",
          parentId: "old-goal-transfer",
          timestamp: "2026-01-01T00:00:02.000Z",
          customType: CUSTOM_ENTRY_TYPE,
          data: noGoalTransfer,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const fallback = readForkTransfer(
      SessionManager.open(fallbackFile),
      [{ type: "message", id: targetA, message: { role: "assistant" } }],
      "2026-01-01T00:00:03.000Z",
      isThreadGoal,
    );
    expect(fallback.kind).toBe("found");
    expect(fallback.kind === "found" ? fallback.transfer.goal : undefined).toBeNull();
  });

  test("forks a non-root active goal durably, reloads deferred, then continues once", async () => {
    let monotonicNow = 1_000;
    const env = await createForkRuntime(() => monotonicNow);
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(runtime.session, "create_goal", {
      objective: "ship exact fork inheritance",
      token_budget: 100,
    });
    const parentFile = seeded.manager.getSessionFile();
    assert.ok(parentFile);
    await runtime.session.extensionRunner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });
    const pendingUsage = assistantMessage(env.model, { input: 12, output: 3 });
    await runtime.session.extensionRunner.emit({
      type: "message_update",
      message: pendingUsage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "working",
        partial: pendingUsage,
      },
    });
    monotonicNow = 4_000;

    const result = await runtime.fork(seeded.secondUserId);
    expect(result.cancelled).toBe(false);
    const childFile = runtime.session.sessionManager.getSessionFile();
    assert.ok(childFile && existsSync(childFile));
    const source = reconstructGoal(SessionManager.open(parentFile).getBranch()).goal;
    assert.ok(source);
    expect(source.usage).toEqual({ tokensUsed: 15, activeSeconds: 3 });
    const inherited = reconstructGoal(SessionManager.open(childFile).getBranch());
    expect(inherited.goal).toEqual(source);
    expect(inherited.deferredTransferId).not.toBeNull();
    expect(countKind(runtime.session.sessionManager, "fork_snapshot")).toBe(1);
    expect(
      runtime.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(0);

    const reloaded = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(childFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    expect(
      reconstructGoal(reloaded.session.sessionManager.getBranch()).deferredTransferId,
    ).not.toBeNull();
    expect(countKind(reloaded.session.sessionManager, "fork_snapshot")).toBe(1);
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      await reloaded.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    }
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      await reloaded.session.extensionRunner.emit({
        type: "turn_start",
        turnIndex: 0,
        timestamp: 2,
      });
    }
    expect(countKind(reloaded.session.sessionManager, "fork_snapshot")).toBe(1);
    expect(countKind(reloaded.session.sessionManager, "fork_deferral")).toBe(1);

    let streamCalls = 0;
    reloaded.session.agent.streamFn = (model) => {
      streamCalls += 1;
      return response(
        model,
        assistantMessage(model, { input: 1, output: 1 }, streamCalls === 1 ? "stop" : "error"),
      );
    };
    await reloaded.session.prompt("destination setup is ready");
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));
    await reloaded.session.agent.waitForIdle();

    const duplicateTerminal = assistantMessage(env.model, { input: 1, output: 1 }, "error");
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      await reloaded.session.extensionRunner.emit({
        type: "turn_end",
        turnIndex: 1,
        message: duplicateTerminal,
        toolResults: [],
      });
      await reloaded.session.extensionRunner.emit({
        type: "agent_end",
        messages: [duplicateTerminal],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));

    expect(streamCalls).toBe(2);
    const afterTurn = reconstructGoal(reloaded.session.sessionManager.getBranch());
    expect(afterTurn.deferredTransferId).toBeNull();
    expect(afterTurn.goal?.status).toBe("blocked");
    expect(countKind(reloaded.session.sessionManager, "fork_deferral")).toBe(1);
    expect(
      reloaded.session.sessionManager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === CUSTOM_ENTRY_TYPE,
        ),
    ).toHaveLength(1);

    reloaded.session.dispose();
    await runtime.dispose();
  });

  test("tree navigation before the child snapshot keeps continuation deferred", async () => {
    const env = await createForkRuntime();
    const manager = SessionManager.create(env.cwd, env.sessionDir);
    manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    manager.appendMessage(assistantMessage(env.model));
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: manager,
    });
    await executeGoalTool(runtime.session, "create_goal", { objective: "copied historical" });
    manager.appendMessage({ role: "user", content: "fork here", timestamp: 2 });
    const copiedAssistantId = manager.appendMessage(assistantMessage(env.model));
    await runtime.session.prompt("/goal clear");
    await executeGoalTool(runtime.session, "create_goal", { objective: "stay deferred" });

    expect((await runtime.fork(copiedAssistantId, { position: "at" })).cancelled).toBe(false);
    expect(
      reconstructGoal(runtime.session.sessionManager.getBranch()).deferredTransferId,
    ).not.toBeNull();
    await runtime.session.prompt("/goal clear");
    await executeGoalTool(runtime.session, "create_goal", { objective: "mutated while deferred" });
    await runtime.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    expect(
      (
        (await executeGoalTool(runtime.session, "get_goal", {})).details as {
          goal: { objective: string };
        }
      ).goal.objective,
    ).toBe("mutated while deferred");
    let streamCalls = 0;
    runtime.session.agent.streamFn = (model) => {
      streamCalls += 1;
      return response(
        model,
        assistantMessage(model, { input: 0, output: 0 }, streamCalls === 1 ? "stop" : "error"),
      );
    };

    await runtime.session.navigateTree(copiedAssistantId, { summarize: false });
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));
    expect(streamCalls).toBe(0);
    expect(
      runtime.session.sessionManager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === CUSTOM_ENTRY_TYPE,
        ),
    ).toHaveLength(0);

    await runtime.session.prompt("destination setup is ready");
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));
    await runtime.session.agent.waitForIdle();
    expect(streamCalls).toBe(2);
    expect(countKind(runtime.session.sessionManager, "fork_deferral")).toBe(1);

    await runtime.session.navigateTree(copiedAssistantId, { summarize: false });
    expect(
      (
        (await executeGoalTool(runtime.session, "get_goal", {})).details as {
          goal: { objective: string };
        }
      ).goal.objective,
    ).toBe("stay deferred");
    await runtime.dispose();
  });

  test("a no-goal fork intent starts normally after reload", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });

    const parentFile = seeded.manager.getSessionFile();
    assert.ok(parentFile);
    expect((await runtime.fork(seeded.secondUserId)).cancelled).toBe(false);
    const childFile = runtime.session.sessionManager.getSessionFile();
    assert.ok(childFile);
    expect(countKind(SessionManager.open(parentFile), "fork_transfer")).toBe(1);
    expect(countKind(runtime.session.sessionManager, "fork_snapshot")).toBe(1);
    expect(reconstructGoal(runtime.session.sessionManager.getBranch()).goal).toBeNull();
    await runtime.dispose();

    const reloaded = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(childFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    await executeGoalTool(reloaded.session, "create_goal", { objective: "created after fork" });
    let streamCalls = 0;
    reloaded.session.agent.streamFn = (model) => {
      streamCalls += 1;
      return response(
        model,
        assistantMessage(model, { input: 0, output: 0 }, streamCalls === 1 ? "stop" : "error"),
      );
    };
    await reloaded.session.prompt("start the new goal");
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));
    await reloaded.session.agent.waitForIdle();

    expect(streamCalls).toBe(2);
    expect(reconstructGoal(reloaded.session.sessionManager.getBranch()).goal?.status).toBe(
      "blocked",
    );
    reloaded.session.dispose();
  });

  test("a repeated-target no-goal fork does not inherit the earlier goal", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const parentFile = seeded.manager.getSessionFile();
    assert.ok(parentFile);
    const first = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(first.session, "create_goal", { objective: "goal A" });
    await first.session.prompt("/goal pause");

    expect((await first.fork(seeded.secondUserId)).cancelled).toBe(false);
    expect(reconstructGoal(first.session.sessionManager.getBranch()).goal?.objective).toBe(
      "goal A",
    );
    await first.dispose();

    const parent = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(parentFile),
    });
    await parent.session.prompt("/goal clear");
    expect(reconstructGoal(parent.session.sessionManager.getBranch()).goal).toBeNull();

    expect((await parent.fork(seeded.secondUserId)).cancelled).toBe(false);
    const secondChildFile = parent.session.sessionManager.getSessionFile();
    assert.ok(secondChildFile);
    const transfers = SessionManager.open(parentFile)
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        (entry.data as { kind?: unknown } | undefined)?.kind === "fork_transfer"
          ? [(entry.data as { goal?: { objective: string } | null }).goal?.objective ?? null]
          : [],
      );
    expect(transfers).toEqual(["goal A", null]);
    expect(countKind(parent.session.sessionManager, "fork_snapshot")).toBe(1);
    expect(reconstructGoal(parent.session.sessionManager.getBranch()).goal).toBeNull();
    await parent.dispose();

    const reloaded = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(secondChildFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    expect(reconstructGoal(reloaded.session.sessionManager.getBranch()).goal).toBeNull();
    reloaded.session.dispose();
  });

  test("forks stopped state and parent/child reopen and mutate independently", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(runtime.session, "create_goal", { objective: "independent branches" });
    await runtime.session.prompt("/goal pause");
    const source = reconstructGoal(seeded.manager.getBranch()).goal;
    const parentFile = seeded.manager.getSessionFile();
    assert.ok(source && parentFile);

    expect((await runtime.fork(seeded.secondUserId)).cancelled).toBe(false);
    const childFile = runtime.session.sessionManager.getSessionFile();
    assert.ok(childFile);
    expect(reconstructGoal(runtime.session.sessionManager.getBranch()).goal).toEqual(source);
    let stoppedStreamCalls = 0;
    runtime.session.agent.streamFn = (model) => {
      stoppedStreamCalls += 1;
      return response(model, assistantMessage(model));
    };
    await runtime.session.prompt("finish destination setup");
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));
    expect(stoppedStreamCalls).toBe(1);
    const clearedStopped = reconstructGoal(runtime.session.sessionManager.getBranch());
    expect(clearedStopped.deferredTransferId).toBeNull();
    expect(clearedStopped.goal?.status).toBe("paused");

    const parent = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(parentFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const child = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(childFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const parentPublic = (await executeGoalTool(parent.session, "get_goal", {})).details as {
      goal: { threadId: string };
    };
    const childPublic = (await executeGoalTool(child.session, "get_goal", {})).details as {
      goal: { threadId: string };
    };
    expect(parentPublic.goal.threadId).toBe(parent.session.sessionId);
    expect(childPublic.goal.threadId).toBe(child.session.sessionId);
    expect(childPublic.goal.threadId).not.toBe(parentPublic.goal.threadId);

    await executeGoalTool(child.session, "update_goal", { status: "complete" });
    await executeGoalTool(parent.session, "update_goal", { status: "blocked" });

    const parentGoal = reconstructGoal(SessionManager.open(parentFile).getBranch()).goal;
    const childGoal = reconstructGoal(SessionManager.open(childFile).getBranch()).goal;
    expect(parentGoal?.goalId).toBe(source.goalId);
    expect(childGoal?.goalId).toBe(source.goalId);
    expect(parentGoal?.status).toBe("blocked");
    expect(childGoal?.status).toBe("complete");

    parent.session.dispose();
    child.session.dispose();
    await runtime.dispose();
  });

  test("inherits active goals across root and pre-assistant forks", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(runtime.session, "create_goal", { objective: "must stay durable" });
    const sourceFile = seeded.manager.getSessionFile();
    assert.ok(sourceFile);
    expect((await runtime.fork(seeded.firstUserId)).cancelled).toBe(false);
    expect(runtime.session.sessionManager.getSessionFile()).not.toBe(sourceFile);
    expect(countKind(SessionManager.open(sourceFile), "fork_transfer")).toBe(1);
    const rootGoal = reconstructGoal(runtime.session.sessionManager.getBranch());
    expect(rootGoal.goal?.objective).toBe("must stay durable");
    expect(rootGoal.deferredTransferId).not.toBeNull();
    await runtime.dispose();

    const manager = SessionManager.create(env.cwd, join(env.root, "no-assistant-sessions"));
    const userId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const noAssistant = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: manager,
    });
    await executeGoalTool(noAssistant.session, "create_goal", { objective: "not yet durable" });
    expect(manager.getSessionFile() && existsSync(manager.getSessionFile()!)).toBe(false);
    expect((await noAssistant.fork(userId)).cancelled).toBe(false);
    const preAssistantGoal = reconstructGoal(noAssistant.session.sessionManager.getBranch());
    expect(preAssistantGoal.goal?.objective).toBe("not yet durable");
    expect(preAssistantGoal.deferredTransferId).not.toBeNull();
    expect(
      noAssistant.session.sessionManager.getSessionFile() &&
        existsSync(noAssistant.session.sessionManager.getSessionFile()!),
    ).toBe(false);
    await noAssistant.dispose();

    const atManager = SessionManager.create(env.cwd, join(env.root, "pre-assistant-at"));
    const atUserId = atManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const atSourceFile = atManager.getSessionFile();
    assert.ok(atSourceFile);
    writeFileSync(
      atSourceFile,
      [atManager.getHeader(), ...atManager.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const atFork = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: atManager,
    });
    await executeGoalTool(atFork.session, "create_goal", { objective: "inherit at user" });
    expect((await atFork.fork(atUserId, { position: "at" })).cancelled).toBe(false);
    const atGoal = reconstructGoal(atFork.session.sessionManager.getBranch());
    expect(atGoal.goal?.objective).toBe("inherit at user");
    expect(atGoal.deferredTransferId).not.toBeNull();
    await atFork.dispose();
  });

  test("does not apply a failed root attempt to a later non-root fork", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(runtime.session, "create_goal", { objective: "failed root goal" });

    const createSession = SessionManager.create;
    SessionManager.create = (() => {
      throw new Error("simulated host root-fork failure");
    }) as typeof SessionManager.create;
    try {
      await expect(runtime.fork(seeded.firstUserId)).rejects.toThrow(
        "simulated host root-fork failure",
      );
    } finally {
      SessionManager.create = createSession;
    }

    await runtime.session.prompt("/goal clear");
    await executeGoalTool(runtime.session, "create_goal", { objective: "non-root goal" });
    expect((await runtime.fork(seeded.secondUserId)).cancelled).toBe(false);
    const inherited = reconstructGoal(runtime.session.sessionManager.getBranch());
    expect(inherited.goal?.objective).toBe("non-root goal");
    expect(inherited.deferredTransferId).not.toBeNull();
    await runtime.dispose();
  });

  test("allows root and pre-assistant forks when no goal exists", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const rootFork = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    expect((await rootFork.fork(seeded.firstUserId)).cancelled).toBe(false);
    await rootFork.dispose();

    const manager = SessionManager.create(env.cwd, join(env.root, "ordinary-no-assistant"));
    const userId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const preAssistant = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: manager,
    });
    expect((await preAssistant.fork(userId)).cancelled).toBe(false);
    await preAssistant.dispose();
  });

  test("cancels a repeated-target no-goal fork when its durable intent fails", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const parentFile = seeded.manager.getSessionFile();
    assert.ok(parentFile);
    const first = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(first.session, "create_goal", { objective: "historical goal A" });
    await first.session.prompt("/goal pause");
    expect((await first.fork(seeded.secondUserId)).cancelled).toBe(false);
    await first.dispose();

    const parent = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(parentFile),
    });
    await parent.session.prompt("/goal clear");
    const manager = parent.session.sessionManager;
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = ((customType: string, data: unknown) => {
      if ((data as { kind?: unknown } | undefined)?.kind === "fork_transfer") {
        throw new Error("simulated null-intent persistence failure");
      }
      return append(customType, data);
    }) as SessionManager["appendCustomEntry"];
    const filesBefore = readdirSync(env.sessionDir).filter((name) => name.endsWith(".jsonl"));

    expect((await parent.fork(seeded.secondUserId)).cancelled).toBe(true);
    expect(parent.session.sessionManager).toBe(manager);
    expect(readdirSync(env.sessionDir).filter((name) => name.endsWith(".jsonl"))).toEqual(
      filesBefore,
    );
    expect(countKind(manager, "fork_transfer")).toBe(1);
    await parent.dispose();

    const afterCrash = await env.createRuntime({
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: SessionManager.open(parentFile),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    expect(reconstructGoal(afterCrash.session.sessionManager.getBranch()).goal).toBeNull();
    afterCrash.session.dispose();
  });

  test("a transfer write failure after accounting flush cancels without corrupting source", async () => {
    const env = await createForkRuntime();
    const seeded = seedPersistedSession(env.cwd, env.sessionDir, env.model);
    const runtime = await createAgentSessionRuntime(env.createRuntime, {
      cwd: env.cwd,
      agentDir: join(env.root, "agent"),
      sessionManager: seeded.manager,
    });
    await executeGoalTool(runtime.session, "create_goal", { objective: "safe failure" });
    await runtime.session.extensionRunner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });
    await runtime.session.extensionRunner.emit({
      type: "message_update",
      message: assistantMessage(env.model, { input: 7, output: 2 }),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "working",
        partial: assistantMessage(env.model, { input: 7, output: 2 }),
      },
    });

    const manager = runtime.session.sessionManager;
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = ((customType: string, data: unknown) => {
      if ((data as { kind?: unknown } | undefined)?.kind === "fork_transfer") {
        throw new Error("simulated transfer write failure");
      }
      return append(customType, data);
    }) as SessionManager["appendCustomEntry"];

    expect((await runtime.fork(seeded.secondUserId)).cancelled).toBe(true);
    const source = reconstructGoal(SessionManager.open(manager.getSessionFile()!).getBranch()).goal;
    expect(source?.usage.tokensUsed).toBe(9);
    expect(source?.status).toBe("active");
    expect(countKind(manager, "fork_transfer")).toBe(0);
    expect(runtime.session.sessionManager).toBe(manager);
    await runtime.dispose();
  });
});
