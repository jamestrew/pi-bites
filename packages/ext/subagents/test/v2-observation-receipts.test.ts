import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { saveSettings } from "../settings.js";
import { harness, setupV2 } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.useRealTimers();
});
const theme = {
  bold: (s: string) => `<b>${s}</b>`,
  fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
};
const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };
function host(tool: any, args: object) {
  initTheme("dark");
  return new ToolExecutionComponent(
    tool.name,
    "receipt",
    args,
    { showImages: false },
    tool,
    { requestRender() {} } as never,
    "/tmp",
  );
}
function rendered(row: ToolExecutionComponent, width = 120) {
  const lines = row.render(width);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  return lines.map((line) => stripVTControlCharacters(line).trim());
}

it("records interrupt submission and previous status once, including already completed targets", async () => {
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "interrupt_agent"];
  h.faux.setResponses([fauxAssistantMessage("finished")]);
  await h.call("spawn_agent", { task_name: "audit_auth", message: "inspect" });
  await h.manager.waitForAll();
  const tool = h.direct.get("interrupt_agent");
  const args = { target: "audit_auth" };
  const context = { state: {}, expanded: false, isError: false };
  const call = tool.renderCall(args, theme, context);
  expect(call.render(120)).toEqual(["<b>interrupt_agent</b><accent> audit_auth</accent>"]);
  const row = host(tool, args);
  const result = await h.call("interrupt_agent", args);
  expect(result.value).toEqual({ previous_status: { completed: "finished" } });
  expect(tool.renderResult(result, {}, theme, context).render(120)).toEqual([]);
  expect(call.render(120)).toEqual([
    "<b>interrupt_agent</b><accent> /root/audit_auth interrupt requested</accent>",
    "",
    "<dim>Previous status: completed</dim>",
  ]);
  row.updateResult({ ...result, isError: false });
  expect(rendered(row).filter(Boolean)).toEqual([
    "interrupt_agent /root/audit_auth interrupt requested",
    "Previous status: completed",
  ]);
  await h.emit("session_shutdown");
  const restored = host(tool, args);
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  for (const expanded of [false, true]) {
    restored.setExpanded(expanded);
    expect(rendered(restored)).toEqual(rendered(row));
    expect(rendered(restored).slice(0, 2)).toEqual(["", ""]);
    expect(rendered(restored).at(-1)).toBe("");
  }
});

it("freezes rich loaded-agent rows without adding activity to the model-facing list", async () => {
  const h = await setupV2(cleanup);
  h.faux.setResponses([fauxAssistantMessage("finished")]);
  await h.call("spawn_agent", { task_name: "audit_auth", message: "inspect" });
  await h.manager.waitForAll();
  const tool = h.direct.get("list_agents");
  const row = host(tool, {});
  expect(rendered(row).filter(Boolean)).toEqual(["list_agents /root"]);
  const result = await h.call("list_agents", {});
  expect(result.value.agents).toEqual([
    { agent_name: "/root", agent_status: "running" },
    { agent_name: "/root/audit_auth", agent_status: { completed: "finished" } },
  ]);
  expect(JSON.parse(result.content[0].text)).toEqual(result.value);
  row.updateResult({ ...result, isError: false });
  const lines = rendered(row).filter(Boolean);
  expect(lines[0]).toBe("list_agents /root 2 loaded");
  expect(lines[1]).toBe("/root running");
  expect(lines[2]).toMatch(
    /^\/root\/audit_auth completed · v2-mail\/test-model off · [\d.]+s · 0 tools · ↑[\d.]+k? ↓2/,
  );
  expect(lines[2]).not.toMatch(/\$|CH/);
  expect(lines.join("\n")).not.toMatch(/subagents|→|finished/);
  const empty = await h.call("list_agents", { path_prefix: "audit" });
  const emptyRow = host(tool, { path_prefix: "audit" });
  emptyRow.updateResult({ ...empty, isError: false });
  expect(rendered(emptyRow).filter(Boolean)).toEqual(["list_agents /root/audit 0 loaded"]);
  await h.emit("session_shutdown");
  const restored = host(tool, {});
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  expect(rendered(restored)).toEqual(rendered(row));
  const styled = { state: {}, expanded: false, isError: false };
  const call = tool.renderCall({}, theme, styled);
  tool.renderResult(result, {}, theme, styled);
  expect(call.render(200)[0]).toBe("<b>list_agents</b><accent> /root 2 loaded</accent>");
  expect(call.render(200)[2]).toBe("<dim>/root running</dim>");
});

it("updates wait timing in place, freezes on mail, and restores without restarting the clock", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent", "send_message"];
  await h.emit("session_start");
  vi.useFakeTimers();
  const tool = h.direct.get("wait_agent");
  const args = { timeout_ms: 5000 };
  const row = host(tool, args);
  row.markExecutionStarted();
  row.setArgsComplete();
  const wait = tool.execute(
    "wait",
    args,
    undefined,
    (result: any) => row.updateResult({ ...result, isError: false }, true),
    h.ctx,
  );
  await vi.advanceTimersByTimeAsync(4000);
  expect(rendered(row).filter(Boolean)).toEqual([
    "wait_agent waiting 4s / timeout 10s",
    "Requested timeout 5s raised to the minimum of 10s.",
  ]);
  await h.call("send_message", { target: "/root", message: "mail" });
  const result = await wait;
  expect(result.value).toEqual({
    message:
      "Wait completed.\n\nRequested timeout of 5000ms was clamped to the minimum of 10000ms.",
    timed_out: false,
  });
  row.updateResult({ ...result, isError: false });
  expect(rendered(row).filter(Boolean)).toEqual([
    "wait_agent completed after 4s",
    "Requested timeout 5s raised to the minimum of 10s.",
  ]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  await h.emit("session_shutdown");
  const restored = host(tool, args);
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  expect(rendered(restored)).toEqual(rendered(row));
  expect(vi.getTimerCount()).toBe(0);
});

it("persists cancelled wait timing through Pi's error-result hook and removes the live timer", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  vi.useFakeTimers();
  const tool = h.direct.get("wait_agent");
  const row = host(tool, {});
  const owner = new AbortController();
  const wait = tool.execute(
    "cancelled-wait",
    {},
    owner.signal,
    (result: any) => row.updateResult({ ...result, isError: false }, true),
    h.ctx,
  );
  const rejected = expect(wait).rejects.toThrow("Wait cancelled.");
  await vi.advanceTimersByTimeAsync(7000);
  const descriptors = Object.getOwnPropertyDescriptors(h.ctx);
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale ctx");
      },
    });
  await vi.advanceTimersByTimeAsync(1000);
  expect(rendered(row).filter(Boolean)[0]).toBe("wait_agent waiting 8s / timeout 30s");
  owner.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  const errorResult = {
    toolName: "wait_agent",
    toolCallId: "cancelled-wait",
    content: [{ type: "text", text: "Wait cancelled." }],
    details: {},
    isError: true,
  };
  const enriched = await h.emit("tool_result", errorResult);
  expect(enriched).toMatchObject({
    details: { wait: { outcome: "cancelled", elapsedMs: 8000, agents: [] } },
  });
  row.updateResult({ ...errorResult, ...(enriched as object) });
  expect(rendered(row).filter(Boolean)).toEqual([
    "wait_agent cancelled after 8s",
    "Error: Wait cancelled.",
  ]);
  expect(await h.emit("tool_result", errorResult)).toBeUndefined();
  Object.defineProperties(h.ctx, descriptors);
  await h.emit("session_shutdown");
  await vi.advanceTimersByTimeAsync(10000);
  const restored = host(tool, {});
  restored.updateResult(JSON.parse(JSON.stringify({ ...errorResult, ...(enriched as object) })));
  expect(rendered(restored)).toEqual(rendered(row));
});

it("observes only direct children, retaining unloaded child counts and each agent's own stats", async () => {
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "list_agents", "wait_agent", "send_message"];
  saveSettings({ maxDepth: 3, maxConcurrent: 4 }, h.ctx.cwd);
  await h.emit("session_start");
  h.faux.setResponses([fauxAssistantMessage("PARENT FINAL")]);
  const parent = await h.call("spawn_agent", {
    task_name: "audit_auth",
    message: "inspect",
    fork_turns: "none",
  });
  await h.manager.waitForAll();
  const parentCtx = {
    ...h.ctx,
    sessionManager: h.manager.getRecord(parent.details.agentId).session.sessionManager,
  };
  h.faux.setResponses([fauxAssistantMessage("UNLOADED FINAL")]);
  const unloaded = await h.direct
    .get("spawn_agent")
    .execute(
      "leaf",
      { task_name: "old_leaf", message: "done", fork_turns: "none" },
      undefined,
      undefined,
      parentCtx,
    );
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(unloaded.details.agentId);
  const work = (names: string[]) => ({
    ...fauxAssistantMessage(""),
    stopReason: "toolUse" as const,
    content: names.map((name) => ({
      type: "toolCall" as const,
      id: name,
      name,
      arguments: (name === "wait_agent" ? { timeout_ms: 3600000 } : {}) as Record<string, number>,
    })),
  });
  h.faux.setResponses([work(["wait_agent"])]);
  await h.direct
    .get("spawn_agent")
    .execute(
      "active-leaf",
      { task_name: "active_leaf", message: "wait", fork_turns: "none" },
      undefined,
      undefined,
      parentCtx,
    );
  await vi.waitFor(
    async () => {
      const observation = await h.direct
        .get("wait_agent")
        .execute("leaf-observation", {}, undefined, undefined, parentCtx);
      expect(
        observation.details.wait.agents.find((a: any) => a.path.endsWith("/active_leaf")).toolCalls,
      ).toHaveLength(1);
    },
    { timeout: 5000 },
  );
  h.faux.setResponses([work(["list_agents", "wait_agent"])]);
  await h.call("spawn_agent", { task_name: "fix_tests", message: "wait", fork_turns: "none" });
  // Observe through the registered list result, not private runner counters.
  await vi.waitFor(
    async () => {
      const list = await h.call("list_agents", {});
      expect(list.details.agents.find((a: any) => a.path === "/root/fix_tests").toolUses).toBe(1);
    },
    { timeout: 5000 },
  );
  await h.emit("context", {
    messages: h.pi.sendMessage.mock.calls.map(([message]: any[]) => ({
      role: "custom",
      ...message,
    })),
  });
  const tool = h.direct.get("wait_agent");
  const row = host(tool, {});
  const waiting = tool.execute(
    "observing",
    {},
    undefined,
    (result: any) => row.updateResult({ ...result, isError: false }, true),
    h.ctx,
  );
  const live = rendered(row, 200).filter(Boolean);
  expect(live[1]).toBe(
    "├─ audit_auth completed · v2-mail/test-model off · 2 subagents (1 running)",
  );
  expect(live[2]).toMatch(/^│  0 tool uses · /);
  expect(live[3]).toBe("└─ fix_tests running · v2-mail/test-model off");
  expect(live[4]).toContain("→ Wait_agent(");
  expect(live.join("\n")).not.toMatch(/active_leaf|old_leaf|FINAL/);
  expect(live.at(-1)).toContain("to expand");
  row.setExpanded(true);
  expect(rendered(row, 200).join("\n")).toContain("→ List_agents(");
  expect(rendered(row, 200).join("\n")).not.toContain("to expand");
  await h.call("send_message", { target: "/root", message: "finish observation" });
  const result = await waiting;
  expect(result.details.wait.agents).toHaveLength(2);
  expect(result.details.wait.agents[0]).toMatchObject({
    path: "/root/audit_auth",
    children: 2,
    runningChildren: 1,
    toolUses: 0,
  });
  row.updateResult({ ...result, isError: false });
  await h.emit("session_shutdown");
  const restored = host(tool, {});
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  restored.setExpanded(true);
  expect(rendered(restored, 200)).toEqual(rendered(row, 200));
}, 20000);

it("keeps a wait failure visible below a compact activity preview and before its hint", () => {
  const tool = harness(cleanup).direct.get("wait_agent");
  const context = { state: {}, expanded: false, isError: true };
  const call = tool.renderCall({}, plain, context);
  tool.renderResult(
    {
      content: [{ type: "text", text: "Mailbox is unavailable." }],
      details: {
        wait: {
          outcome: "failed",
          elapsedMs: 2000,
          timeoutMs: 30000,
          requestedMs: 30000,
          agents: Array.from({ length: 10 }, (_, i) => ({
            path: `/root/a${i}`,
            status: "running",
            toolCalls: ["read file"],
          })),
        },
      },
    },
    {},
    plain,
    context,
  );
  const lines = call.render(100);
  expect(lines[0]).toBe("wait_agent failed");
  expect(lines.length).toBeLessThanOrEqual(11);
  expect(lines.slice(-3, -1)).toEqual(["", "Error: Mailbox is unavailable."]);
  expect(lines.at(-1)).toContain("to expand");
  context.expanded = true;
  expect(call.render(100).at(-1)).toBe("Error: Mailbox is unavailable.");
});

it("persists the executed wait's cancellation snapshot through a real Pi tool-result event", async () => {
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "wait_agent", "interrupt_agent"];
  h.faux.setResponses([
    {
      ...fauxAssistantMessage(""),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "native-wait",
          name: "wait_agent",
          arguments: { timeout_ms: 3600000 },
        },
      ],
    },
  ]);
  const spawned = await h.call("spawn_agent", {
    task_name: "waiting",
    message: "wait",
    fork_turns: "none",
  });
  const session = h.manager.getRecord(spawned.details.agentId).session;
  const updates: any[] = [];
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "tool_execution_update") updates.push(event.partialResult);
  });
  try {
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 5000 });
    await h.call("interrupt_agent", { target: "waiting" });
    await h.manager.waitForAll();
    const saved = session.messages.find(
      (message: any) => message.role === "toolResult" && message.toolCallId === "native-wait",
    );
    expect(saved).toMatchObject({
      isError: true,
      details: { wait: { outcome: "cancelled", agents: [], timeoutMs: 3600000 } },
    });
    const restored = host(h.direct.get("wait_agent"), { timeout_ms: 3600000 });
    restored.updateResult(JSON.parse(JSON.stringify(saved)));
    expect(rendered(restored)[2]).toMatch(/^wait_agent cancelled after [\d.]+s$/);
  } finally {
    unsubscribe();
  }
}, 15000);

it("uses the configured expansion binding and safely fits frozen lists, activity, and errors", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const {
    getKeybindings,
    setKeybindings,
    KeybindingsManager,
  }: typeof import("@earendil-works/pi-tui") = await import(
    pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href
  );
  const previous = getKeybindings();
  setKeybindings(
    new KeybindingsManager(
      { "app.tools.expand": { defaultKeys: "ctrl+o" } },
      { "app.tools.expand": "alt+e" },
    ),
  );
  try {
    const h = harness(cleanup);
    const agents = Array.from({ length: 10 }, (_, i) => ({
      path: `/root/a${i}`,
      status: "completed",
      model: "openai/gpt-5.4",
      thinking: "high",
      durationMs: 12000,
      toolUses: 6,
      usage: { input: 800, output: 1100, cacheWrite: 0, cacheRead: 9200, cost: 0.034 },
      toolCalls: ["old activity", "latest activity"],
      children: 2,
      runningChildren: 1,
    }));
    const list = h.direct.get("list_agents");
    const listContext = { state: {}, expanded: false, isError: false };
    const listCall = list.renderCall({}, plain, listContext);
    const result = { content: [], details: { prefix: "/root", agents } };
    list.renderResult(result, {}, plain, listContext);
    expect(stripVTControlCharacters(listCall.render(200).at(-1)!)).toBe("(alt+e to expand)");
    expect(listCall.render(200)).toHaveLength(11);
    expect(listCall.render(200).slice(2, -1)).toHaveLength(8);
    expect(listCall.render(200)[2]).toBe(
      "/root/a0 completed · openai/gpt-5.4 high · 12s · 6 tools · ↑800 ↓1.1k R9.2k CH92% $0.034",
    );
    expect(listCall.render(200).join("\n")).not.toMatch(/activity|subagents/);
    listContext.expanded = true;
    expect(listCall.render(200)).toHaveLength(12);
    const fixtures = [
      { name: "list_agents", result, error: false },
      {
        name: "wait_agent",
        result: {
          content: [],
          details: {
            wait: {
              outcome: "completed",
              elapsedMs: 12000,
              requestedMs: 30000,
              timeoutMs: 30000,
              agents,
            },
          },
        },
        error: false,
      },
      {
        name: "interrupt_agent",
        result: {
          content: [
            {
              type: "text",
              text: "Error: " + "很长的错误 ".repeat(100) + "\x1b]0;malicious\x07tail",
            },
          ],
        },
        error: true,
      },
    ];
    for (const { name, result, error } of fixtures) {
      const tool = h.direct.get(name);
      const args = { target: "a\n\x1b[31mb", path_prefix: "/root\x1b]0;malicious\x07" };
      const context = { state: {}, expanded: false, isError: error };
      const call = tool.renderCall(args, plain, context);
      expect(tool.renderResult(result, {}, plain, context).render(120)).toEqual([]);
      expect(stripVTControlCharacters(call.render(100).at(-1)!)).toBe("(alt+e to expand)");
      const row = host(tool, args);
      row.updateResult({ ...result, isError: error });
      for (const expanded of [false, true]) {
        row.setExpanded(expanded);
        for (const width of [4, 12, 30, 120]) {
          const lines = rendered(row, width);
          expect(lines.join("\n")).not.toContain("malicious");
          expect(lines.join("\n")).not.toContain("\x1b");
          expect(lines.slice(0, 2)).toEqual(["", ""]);
          expect(lines.at(-1)).toBe("");
        }
        if (expanded) expect(rendered(row, 200).join("\n")).not.toContain("to expand");
      }
    }
    listContext.expanded = false;
    list.renderResult(
      { content: [], details: { prefix: "/root", agents: agents.slice(0, 8) } },
      {},
      plain,
      listContext,
    );
    expect(listCall.render(20).join("\n")).not.toContain("to expand");
  } finally {
    setKeybindings(previous);
  }
});

it.each([
  ["timeout", "timed out", true],
  ["input", "interrupted by new input", false],
] as const)("freezes %s as a normal wait outcome", async (outcome, label, timedOut) => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  h.ctx.hasPendingMessages = () => true;
  vi.useFakeTimers();
  const waiting = h.call("wait_agent", { timeout_ms: 10000 });
  await vi.advanceTimersByTimeAsync(outcome === "timeout" ? 10000 : 8000);
  if (outcome === "input") {
    await h.emit("input", { source: "interactive" });
    await vi.advanceTimersByTimeAsync(25);
  }
  const result = await waiting;
  expect(result.value.timed_out).toBe(timedOut);
  expect(result.details.wait.outcome).toBe(outcome);
  const row = host(h.direct.get("wait_agent"), { timeout_ms: 10000 });
  row.updateResult({ ...result, isError: false });
  expect(rendered(row).filter(Boolean)).toEqual([
    `wait_agent ${label} after ${timedOut ? "10s" : "8s"}`,
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
