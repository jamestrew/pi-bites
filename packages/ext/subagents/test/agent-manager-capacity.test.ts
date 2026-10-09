import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { AgentManager } from "../agent-manager.js";
import { spawnNamed } from "../task-paths.js";
import { setupV2 } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const fn of cleanup.splice(0)) await fn();
});

it("checks execution before accepting follow-up without reserving or rechecking at start", async () => {
  const h = await setupV2(cleanup);
  const manager = new AgentManager();
  managers.push(manager);
  h.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("done")));
  const ids: string[] = [];
  for (const taskName of ["a", "b", "c"]) {
    ids.push(
      await spawnNamed(manager, h.pi, h.ctx, "worker", "initial", {
        taskName,
        description: taskName,
        isolated: true,
      }),
    );
    await manager.waitForAll();
  }
  manager.setMaxConcurrent(1);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.faux.setResponses(
    Array.from({ length: 2 }, () => async () => {
      await pending;
      return fauxAssistantMessage("follow-up done");
    }),
  );
  try {
    expect(
      manager.followup(
        ids[0]!,
        () => {
          expect(manager.startTurn(ids[1]!, "another accepted task")).toBe(true);
          return true;
        },
        () => false,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(h.faux.state.callCount).toBe(5));
    expect(() => manager.startTurn(ids[2]!, "too late")).toThrow(/slot/);
    expect(manager.getRecord(ids[2]!)!.generation).toBe(1);
  } finally {
    finish();
    await manager.waitForAll();
  }
  h.faux.setResponses([fauxAssistantMessage("capacity released")]);
  expect(manager.startTurn(ids[2]!, "capacity released")).toBe(true);
  await manager.waitForAll();
  expect(manager.getRecord(ids[2]!)!.result).toBe("capacity released");
}, 30_000);

it("publishes a reopened resident before runtime-loaded callbacks can admit another child", async () => {
  const h = await setupV2(cleanup);
  const manager = new AgentManager(undefined, 1);
  managers.push(manager);
  h.faux.setResponses([fauxAssistantMessage("saved"), fauxAssistantMessage("second")]);
  const id = await spawnNamed(manager, h.pi, h.ctx, "worker", "first", {
    taskName: "a",
    description: "a",
    isolated: true,
  });
  await manager.waitForAll();
  await manager.close(id);
  let attempted: Promise<string> | undefined;
  manager.onRuntimeLoaded = () => {
    attempted = spawnNamed(manager, h.pi, h.ctx, "worker", "second", {
      taskName: "b",
      description: "b",
      isolated: true,
    });
    void attempted.catch(() => {});
  };
  await manager.reopen(h.pi, h.ctx, id);
  expect(attempted).toBeDefined();
  await expect(attempted).rejects.toThrow("runtime slot");
  expect(manager.listAgents().filter((record) => record.session)).toHaveLength(1);
}, 30_000);

it("keeps a newer native run counted while the previous prompt finishes unwinding", async () => {
  const h = await setupV2(cleanup);
  const manager = new AgentManager(undefined, 1);
  managers.push(manager);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.faux.setResponses([
    fauxAssistantMessage("first done"),
    async () => {
      await pending;
      return fauxAssistantMessage("second done");
    },
  ]);
  let next: Promise<void> | undefined;
  let scheduled = false;
  try {
    const id = await spawnNamed(manager, h.pi, h.ctx, "worker", "first", {
      taskName: "a",
      description: "a",
      isolated: true,
      onSessionCreated: (session) => {
        session.subscribe((event) => {
          if (event.type !== "agent_settled" || scheduled) return;
          scheduled = true;
          queueMicrotask(() => {
            next = session.sendCustomMessage(
              { customType: "next-task", content: "second", display: false },
              { triggerTurn: true },
            );
          });
        });
      },
    });
    await vi.waitFor(() => expect(h.faux.state.callCount).toBe(2));
    await manager.getRecord(id)!.promise;
    await expect(
      spawnNamed(manager, h.pi, h.ctx, "worker", "blocked", { taskName: "b", description: "b" }),
    ).rejects.toThrow("concurrency slot");
    await expect(manager.disposeRuntime(id)).rejects.toThrow("busy");
  } finally {
    finish();
    await next;
    await manager.waitForAll();
  }
  expect(() => manager.assertExecutionAvailable()).not.toThrow();
}, 30_000);
