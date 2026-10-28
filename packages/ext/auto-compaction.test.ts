import { afterEach, expect, it } from "vitest";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  getApiProvider,
} from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerAutoCompaction from "./auto-compaction.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function setup(tokens = 42_000, contextWindow = 1_000_000, thresholdTokens = 42_000) {
  const faux = registerFauxProvider({
    provider: "compaction-test",
    models: [{ id: "test", contextWindow }],
  });
  cleanup.push(() => faux.unregister());
  faux.setResponses([fauxAssistantMessage("Checkpoint")]);
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "Old task. ".repeat(1000), timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("Old answer ".repeat(1000)));
  manager.appendMessage({ role: "user", content: "Recent task", timestamp: 2 });
  manager.appendMessage(fauxAssistantMessage("Recent answer"));
  const handlers = new Map<string, Function>();
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getSettings: () => ({ compaction: { keepRecentTokens: 100, reserveTokens: 500 } }),
    getThinkingLevel: () => "off",
  };
  registerAutoCompaction(pi as never, { current: { autoCompaction: { thresholdTokens } } });
  let stale = false;
  const controller = new AbortController();
  const dependencies = {
    model: faux.getModel(),
    modelRegistry: { streamSimple: getApiProvider(faux.api)!.streamSimple },
    signal: controller.signal,
    sessionManager: manager,
    getContextUsage: () => ({ tokens, contextWindow }),
    hasUI: false,
  };
  const ctx = Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [key, value]));
  for (const key of Object.keys(ctx))
    Object.defineProperty(ctx, key, {
      get() {
        if (stale) throw new Error("stale ctx");
        return dependencies[key as keyof typeof dependencies];
      },
    });
  const event = () => ({
    entries: [],
    outcome: "completed",
    context: {
      contextEntries: manager
        .getBranch()
        .flatMap((sourceEntry) =>
          sourceEntry.type === "message" ? [{ sourceEntry, messages: [sourceEntry.message] }] : [],
        ),
      contextMessages: manager.buildSessionContext().messages,
    },
  });
  return {
    manager,
    faux,
    ctx,
    event,
    handlers,
    abort: () => controller.abort(),
    invalidate: () => {
      stale = true;
    },
    boundary: (name = "turn_end", e = event()) => handlers.get(name)!(e, ctx),
  };
}

it("compacts at the configured threshold using the public boundary without forcing continuation", async () => {
  const h = setup();
  const result = await h.boundary();
  expect(result).toMatchObject({
    entries: [expect.objectContaining({ type: "compaction", summary: "Checkpoint" })],
  });
  expect(result.continue).toBeUndefined();
});

it.each([
  [41_999, 1_000_000, false],
  [8_499, 10_000, false],
  [8_500, 10_000, true],
])(
  "applies the configured threshold and 85%% ceiling at %i tokens",
  async (tokens, window, fires) => {
    const h = setup(tokens, window);
    expect(Boolean(await h.boundary())).toBe(fires);
  },
);

it("also compacts before settlement without forcing an additional turn", async () => {
  const h = setup();
  expect(await h.boundary("agent_before_settle")).toMatchObject({
    entries: [expect.objectContaining({ type: "compaction" })],
  });
});

it("does not repeat a proposed checkpoint or compact aborted boundaries", async () => {
  const h = setup();
  const result = await h.boundary();
  expect(
    await h.boundary("agent_before_settle", { ...h.event(), entries: result.entries }),
  ).toBeUndefined();
  expect(
    await h.handlers.get("turn_end")!({ ...h.event(), outcome: "aborted" }, h.ctx),
  ).toBeUndefined();
  expect(h.faux.state.callCount).toBe(1);
});

it("summarizes projected content, retains the recent tail, and never reads stale ctx after awaiting", async () => {
  const h = setup();
  const e = h.event();
  const first = e.context.contextEntries[0]!;
  first.messages = [{ role: "user", content: "PROJECTED_TASK ".repeat(1000), timestamp: 1 }];
  let transcript = "";
  h.faux.setResponses([
    (context) => {
      transcript = JSON.stringify(context);
      h.invalidate();
      return fauxAssistantMessage("Projected checkpoint");
    },
  ]);
  const result = await h.boundary("turn_end", e);
  expect(transcript).toContain("PROJECTED_TASK");
  expect(transcript).not.toContain("Old task.");
  expect(transcript).not.toContain("Recent task");
  expect(result.entries[0].firstKeptEntryId).toBe(e.context.contextEntries[1]!.sourceEntry.id);
});

it.each(["empty summary", "cancelled summary"])(
  "leaves context intact after %s",
  async (failure) => {
    const h = setup();
    const original = structuredClone(h.manager.getBranch());
    h.faux.setResponses([
      () => {
        if (failure === "cancelled summary") h.abort();
        return fauxAssistantMessage(failure === "empty summary" ? "" : "Cancelled checkpoint");
      },
    ]);
    expect(await h.boundary()).toBeUndefined();
    expect(h.manager.getBranch()).toEqual(original);
  },
);

it("uses the same public compaction handler in real child sessions", async () => {
  const { setupV2 } = await import("./subagents/test/helpers/v2-harness.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dispose: (() => Promise<unknown>)[] = [];
  try {
    const h = await setupV2(dispose);
    mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(h.ctx.cwd, ".pi/pi-bites.json"),
      JSON.stringify({ autoCompaction: { thresholdTokens: 1000 } }),
    );
    writeFileSync(
      join(h.ctx.cwd, ".pi/settings.json"),
      JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 500 } }),
    );
    const reply = fauxAssistantMessage("Final child answer ".repeat(1000));
    reply.usage = { ...reply.usage, input: 2000, totalTokens: 2000 };
    h.faux.setResponses([reply, fauxAssistantMessage("Child checkpoint")]);
    let id = "";
    h.pi.events.on("subagents:created", (event: any) => {
      id = event.id;
    });
    await h.call("spawn_agent", {
      task_name: "compact",
      fork_turns: "none",
      message: "Child task ".repeat(1000),
    });
    await h.manager.waitForAll();
    const child = h.manager.getRecord(id);
    expect(child.status).toBe("completed");
    expect(child.compactionCount).toBe(1);
    expect(child.session.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: "Child checkpoint" }),
    );
    expect(h.faux.state.callCount).toBe(2);
    h.faux.setResponses([reply, fauxAssistantMessage("Follow-up checkpoint")]);
    await h.call("followup_task", { target: "compact", message: "Next child task ".repeat(1000) });
    await h.manager.waitForAll();
    expect(child.compactionCount).toBe(2);
    expect(child.session.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: "Follow-up checkpoint" }),
    );
  } finally {
    for (const fn of dispose.reverse()) await fn();
  }
});
