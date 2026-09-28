import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../agent-manager.js";
import { spawnNamed } from "../task-paths.js";
import { mockCtx, mockPi, mockSession } from "./helpers/agent-manager-mocks.js";
vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
}));
import { runAgent } from "../agent-runner.js";
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  vi.clearAllMocks();
});

it("addresses canonical and caller-relative paths within one root, never by parsed ID alone", async () => {
  vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
    const session = mockSession();
    session.sessionManager = SessionManager.inMemory("/tmp", { id: options.agentId });
    session.sessionManager.appendMessage({ role: "user", content: "retained task", timestamp: 1 });
    options.onSessionCreated?.(session);
    return { responseText: "done", session };
  });
  const manager = new AgentManager();
  managers.push(manager);
  manager.tree.setMaxDepth(3);
  const root = { ...mockCtx, sessionManager: SessionManager.inMemory("/tmp", { id: "root" }) };
  const spawn = (ctx: typeof root, name: string) =>
    spawnNamed(manager, mockPi, ctx, "default", "x", { taskName: name, description: name });
  const a = await spawn(root, "a");
  const b = await spawn(root, "b");
  const childA = { ...root, sessionManager: manager.getRecord(a)!.session!.sessionManager };
  const childB = { ...root, sessionManager: manager.getRecord(b)!.session!.sessionManager };
  const aa = await spawn(childA, "task");
  const ba = await spawn(childB, "task");
  expect(manager.taskPaths.lookup("root", "a/task").id).toBe(aa);
  expect(manager.taskPaths.lookup(a, "task").id).toBe(aa);
  expect(manager.taskPaths.lookup(a, "/root/b/task").id).toBe(ba);
  const foreign = await spawn(
    { ...root, sessionManager: SessionManager.inMemory("/tmp", { id: "foreign" }) },
    "task",
  );
  expect(() => manager.taskPaths.lookup(a, foreign)).toThrow("not owned");
  expect(() => manager.taskPaths.lookup(a, "../b")).toThrow("reserved");
  await manager.waitForAll();
  await manager.disposeRuntime(a);
  expect(manager.taskPaths.lookup("root", "a").id).toBe(a);
  expect(manager.taskPaths.lookup(a, "task").id).toBe(aa);
  await expect(spawn(root, "a")).rejects.toThrow("reserved");
  expect(manager.taskPaths.lookup("root", "a").session).toBeUndefined();
});
