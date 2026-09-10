import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test as nativeTest } from "vitest";
import { getCodeModeHostPath } from "./code-mode/binary.js";

function testHost(): string | undefined {
  if (process.env.PI_BITES_TEST_CODE_MODE_HOST) return process.env.PI_BITES_TEST_CODE_MODE_HOST;
  try {
    return getCodeModeHostPath();
  } catch {
    /* Manual dependency may not be installed. */
  }
  const built = join(import.meta.dirname, "vendor/code-mode/target/release/codex-code-mode-host");
  return existsSync(built) ? built : undefined;
}
const hostBinary = testHost();
const test = nativeTest.skipIf(!hostBinary);
import type { RuntimeOptions } from "./code-mode/runtime.js";
import type { RuntimeTool } from "./code-mode/types.js";
import { CodeModeLifecycle } from "./code-mode/lifecycle.js";
import { CodeModeRuntime } from "./code-mode/runtime.js";

const runtimes: CodeModeRuntime[] = [];
function runtime(options: Partial<RuntimeOptions> = {}) {
  const value = new CodeModeRuntime({
    binary: hostBinary,
    tools: [],
    ...options,
  });
  runtimes.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.shutdown()));
});

test("executes in fresh isolates and carries explicit stored values between cells", async () => {
  const host = runtime();
  expect(await host.execute('const local = 7; store("answer", 42); text(local);')).toMatchObject({
    kind: "result",
    contentItems: [{ type: "input_text", text: "7" }],
  });
  expect(await host.execute('text(typeof local); text(load("answer"));')).toMatchObject({
    kind: "result",
    contentItems: [
      { type: "input_text", text: "undefined" },
      { type: "input_text", text: "42" },
    ],
  });
});

test("repeated waits deliver incremental output, completion consumes the opaque cell ID", async () => {
  const host = runtime();
  const first = await host.execute(
    'text("first"); await yield_control(); await new Promise(r => setTimeout(r, 80)); text("second"); await yield_control(); await new Promise(r => setTimeout(r, 80)); text("last");',
  );
  expect(first).toMatchObject({
    kind: "yielded",
    contentItems: [{ type: "input_text", text: "first" }],
  });
  const empty = await host.wait(first.cellId, 0);
  expect(empty).toMatchObject({ kind: "yielded", contentItems: [] });
  const second = await host.wait(first.cellId, 1000);
  expect(second).toMatchObject({
    kind: "yielded",
    contentItems: [{ type: "input_text", text: "second" }],
  });
  expect(await host.wait(first.cellId, 1000)).toMatchObject({
    kind: "result",
    contentItems: [{ type: "input_text", text: "last" }],
  });
  expect(await host.wait(first.cellId)).toMatchObject({
    kind: "result",
    missingCell: true,
    errorText: `exec cell ${first.cellId} not found`,
  });
  await expect(host.wait(1 as unknown as string)).rejects.toThrow(/shell session ID/);
  expect(await host.terminate("absent")).toMatchObject({ missingCell: true });
});

test("native source pragmas accept null/zero/large budgets and reject malformed input", async () => {
  const host = runtime();
  expect(
    await host.execute('  // @exec: {"yield_time_ms":null,"max_output_tokens":0}\r\ntext("zero");'),
  ).toMatchObject({ kind: "result", maxOutputTokens: 0 });
  expect(
    await host.execute('// @exec: {"max_output_tokens":9007199254740991}\ntext("large");'),
  ).toMatchObject({ maxOutputTokens: Number.MAX_SAFE_INTEGER });
  for (const source of [
    " ",
    "// @exec: {}",
    "// @exec: []\ntext(1)",
    '// @exec: {"wrong":1}\ntext(1)',
    '// @exec: {"yield_time_ms":-1}\ntext(1)',
    '// @exec: {"max_output_tokens":0.5}\ntext(1)',
  ]) {
    await expect(host.execute(source)).rejects.toThrow();
  }
  expect(await host.execute('throw new Error("script failure")')).toMatchObject({
    kind: "result",
    errorText: expect.stringContaining("script failure"),
  });
});

function tool(name: string, invoke: RuntimeTool["invoke"]): RuntimeTool {
  return { name, description: name, kind: "function", inputSchema: { type: "object" }, invoke };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("caught individual rejection and allSettled allow siblings; unhandled aggregate finalization cancels them", async () => {
  const aborted: AbortSignal[] = [];
  const host = runtime({
    tools: [
      tool("deny", async () => {
        throw new Error("permission denied");
      }),
      tool("sibling", async (_input, { signal }) => {
        aborted.push(signal);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        signal.throwIfAborted();
        return "sibling finished";
      }),
    ],
  });
  expect(
    await host.execute(
      "try { await tools.deny({}); } catch (e) { text(String(e)); } text(await tools.sibling({}));",
    ),
  ).toMatchObject({
    kind: "result",
    contentItems: [
      { type: "input_text", text: expect.stringContaining("permission denied") },
      { type: "input_text", text: "sibling finished" },
    ],
  });
  expect(aborted[0]?.aborted).toBe(false);
  const settled = await host.execute(
    "text(await Promise.allSettled([tools.deny({}), tools.sibling({})]));",
  );
  expect(settled.errorText).toBeUndefined();
  expect(JSON.stringify(settled.contentItems)).toContain("sibling finished");
  expect(aborted[1]?.aborted).toBe(false);
  const failed = await host.execute("await Promise.all([tools.deny({}), tools.sibling({})]);");
  expect(failed.errorText).toContain("permission denied");
  await expect.poll(() => aborted[2]?.aborted).toBe(true);
});

test("termination cancels approvals and late replies cannot launch further delegates", async () => {
  const approval = deferred();
  const entered = deferred<AbortSignal>();
  let launches = 0;
  const host = runtime({
    tools: [
      tool("approval", async (_input, { signal }) => {
        entered.resolve(signal);
        await approval.promise;
        signal.throwIfAborted();
        launches++;
        return "approved";
      }),
      tool("after", async () => {
        launches++;
      }),
    ],
  });
  const first = await host.execute(
    '// @exec: {"yield_time_ms":0}\nawait tools.approval({}); await tools.after({});',
  );
  const signal = await entered.promise;
  expect(await host.terminate(first.cellId)).toMatchObject({ kind: "terminated" });
  expect(signal.aborted).toBe(true);
  approval.resolve();
  expect(await host.execute('text("still usable")')).toMatchObject({ kind: "result" });
  expect(launches).toBe(0);
  expect(await host.wait(first.cellId)).toMatchObject({ missingCell: true });
});

test("notifications reach updates and exactly one observation", async () => {
  const updates: string[] = [];
  const host = runtime({ onNotification: (_id, text) => updates.push(text) });
  const first = await host.execute(
    'notify("notice"); await new Promise(r => setTimeout(r, 30)); await yield_control(); await new Promise(r => setTimeout(r, 30)); text("done");',
  );
  expect(updates).toEqual(["notice"]);
  expect(first.contentItems).toEqual([{ type: "input_text", text: "notice" }]);
  expect((await host.wait(first.cellId, 1000)).contentItems).toEqual([
    { type: "input_text", text: "done" },
  ]);
});

test("normal completion preserves resumable shells, explicit cancellation terminates only owned shells", async () => {
  const running = new Set<number>();
  let next = 100;
  const host = runtime({
    shells: { terminateSession: (id) => running.delete(id), onSessionExit: () => () => {} },
    tools: [
      tool("shell", async (_input, { ownShell }) => {
        const id = next++;
        running.add(id);
        ownShell(id);
        return id;
      }),
    ],
  });
  await host.execute("text(await tools.shell({}));");
  const yielded = await host
    .execute("text(await tools.shell({})); await new Promise(() => {});\n", AbortSignal.timeout(50))
    .catch(() => undefined);
  expect(yielded).toBeUndefined();
  expect(running.has(100)).toBe(true);
  expect(running.has(101)).toBe(false);
  const other = await host.execute(
    '// @exec: {"yield_time_ms":20}\ntext(await tools.shell({})); await new Promise(() => {});',
  );
  const cancelled = await host.execute(
    '// @exec: {"yield_time_ms":20}\ntext(await tools.shell({})); await new Promise(() => {});',
  );
  await host.terminate(cancelled.cellId);
  expect(running).toEqual(new Set([100, 102]));
  await host.shutdown();
  expect(running.size).toBe(0);
  await expect(host.wait(other.cellId)).rejects.toThrow(/shut down/);
});

test("cell IDs are distinct from shell IDs and cannot address a replacement runtime", async () => {
  const old = runtime();
  const first = await old.execute('// @exec: {"yield_time_ms":0}\nawait new Promise(() => {});');
  expect(first.cellId).not.toMatch(/^\d+$/);
  await old.shutdown();
  const replacement = runtime();
  const second = await replacement.execute(
    '// @exec: {"yield_time_ms":0}\nawait new Promise(() => {});',
  );
  expect(second.cellId).not.toBe(first.cellId);
  expect(await replacement.terminate(first.cellId)).toMatchObject({ missingCell: true });
  expect(await replacement.wait(second.cellId, 0)).toMatchObject({ kind: "yielded" });
});

test.each(["branch", "replacement", "reload", "shutdown", "unsupported"] as const)(
  "%s invalidates runtime without accessing stale context",
  async (event) => {
    let stale = false;
    let sourceCwd = "/initial";
    const ctx = {
      get cwd() {
        if (stale) throw new Error("stale cwd");
        return sourceCwd;
      },
      get sessionManager() {
        if (stale) throw new Error("stale sessionManager");
        return { getSessionId: () => "session-one" };
      },
    };
    const notices: string[] = [];
    const owner = new CodeModeLifecycle(
      (snapshot) => ({
        binary: hostBinary,
        tools: [tool("cwd", async () => snapshot.cwd)],
      }),
      (reason) => notices.push(reason),
    );
    owner.sessionStart(ctx, true);
    const old = owner.current();
    runtimes.push(old);
    const cell = await old.execute('store("key", 123); text(await tools.cwd({}));');
    expect(cell.contentItems).toEqual([{ type: "input_text", text: "/initial" }]);
    owner.modelSelected(true);
    expect(owner.current()).toBe(old);
    expect((await old.execute('text(load("key"));')).contentItems).toEqual([
      { type: "input_text", text: "123" },
    ]);
    const pending = await old.execute(
      '// @exec: {"yield_time_ms":0}\nawait new Promise(r => setTimeout(r, 50)); text(await tools.cwd({}));',
    );
    stale = true;
    // A delegate after yield uses only the snapshot even though every original getter throws.
    expect((await old.wait(pending.cellId, 1000)).contentItems).toEqual([
      { type: "input_text", text: "/initial" },
    ]);
    if (event === "branch") owner.branchChanged();
    else if (event === "replacement") {
      sourceCwd = "/replacement";
      owner.sessionStart(
        { cwd: sourceCwd, sessionManager: { getSessionId: () => "session-two" } },
        true,
      );
    } else if (event === "unsupported") {
      owner.modelSelected(false);
      expect(() => owner.current()).toThrow(/scope/);
      owner.modelSelected(true);
    } else {
      owner.shutdown(event);
      expect(() => owner.current()).toThrow(/scope/);
      owner.sessionStart({ cwd: "/new", sessionManager: { getSessionId: () => "new" } }, true);
    }
    await expect(old.execute('text("stale")')).rejects.toThrow(/shut down/);
    const fresh = owner.current();
    runtimes.push(fresh);
    expect((await fresh.execute('text(load("key"));')).contentItems).toEqual([
      { type: "input_text", text: "undefined" },
    ]);
    expect(notices).toHaveLength(1);
    owner.shutdown();
    owner.shutdown();
  },
);

test("shutdown during lazy startup rejects pending work and never revives the host", async () => {
  const host = runtime();
  const pending = host.execute('text("must not run");');
  const failure = expect(pending).rejects.toThrow(/shut down/);
  await host.shutdown();
  await failure;
  await expect(host.execute('text("again");')).rejects.toThrow(/shut down/);
});

test("retained native stored values trigger visible memory containment instead of growing forever", async () => {
  const host = runtime({ hostLimits: { maxResidentBytes: 96 * 1024 * 1024 } });
  await expect(
    host.execute('store("large", "x".repeat(128 * 1024 * 1024)); await new Promise(() => {});'),
  ).rejects.toThrow(/resident memory limit/);
  await expect(host.execute('text("no automatic restart")')).rejects.toThrow(
    /resident memory limit/,
  );
});

test("unconsumed notification output overflow fails the host visibly", async () => {
  const host = runtime();
  await expect(
    host.execute(
      'notify("x".repeat(1024 * 1024 + 1)); await new Promise(r => setTimeout(r, 1000));',
    ),
  ).rejects.toThrow(/notification output limit/);
});

test("unconsumed cells are bounded, and consuming a result releases capacity", async () => {
  const host = runtime();
  const cells: string[] = [];
  for (let i = 0; i < 64; i++) {
    cells.push(
      (await host.execute('// @exec: {"yield_time_ms":0}\nawait new Promise(() => {});')).cellId,
    );
  }
  await expect(host.execute('text("overflow")')).rejects.toThrow(/live cell limit/);
  await host.terminate(cells[0]!);
  expect(await host.execute('text("capacity released")')).toMatchObject({ kind: "result" });
});

test("a real-host crash rejects all observations, cancels delegates and owned shells", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "code-mode-crash-"));
  const binary = join(directory, "host");
  const pidFile = join(directory, "pid");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(binary, `#!/bin/sh\necho $$ > ${quote(pidFile)}\nexec ${quote(hostBinary!)}\n`, {
    mode: 0o755,
  });
  const entered = deferred<AbortSignal>();
  const running = new Set<number>([33]);
  const host = runtime({
    binary,
    shells: { terminateSession: (id) => running.delete(id), onSessionExit: () => () => {} },
    tools: [
      tool("pending", async (_input, { signal, ownShell }) => {
        ownShell(33);
        entered.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }),
    ],
  });
  try {
    const cell = await host.execute('// @exec: {"yield_time_ms":0}\nawait tools.pending({});');
    const signal = await entered.promise;
    const wait = host.wait(cell.cellId);
    const execute = host.execute("await new Promise(() => {});");
    // Attach handlers before killing to exercise all pending requests without unhandled rejections.
    const failures = Promise.allSettled([wait, execute]);
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    for (const result of await failures) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(String(result.reason)).toMatch(/host exited/);
    }
    expect(signal.aborted).toBe(true);
    expect(running.size).toBe(0);
    await expect(host.execute('text("restart")')).rejects.toThrow(/host exited/);
  } finally {
    await host.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real shell manager preserves completed-cell processes and cancels only a live cell's processes", async () => {
  const { createExecSessionManager } = await import("./exec/session-manager.js");
  const shells = createExecSessionManager({
    minNonInteractiveExecYieldTimeMs: 0,
    minEmptyWriteYieldTimeMs: 250,
    maxEmptyWriteYieldTimeMs: 1000,
  });
  const host = runtime({
    shells,
    tools: [
      tool("shell", async (_input, call) => {
        const result = await shells.exec(
          { cmd: "printf ready; sleep 30", yield_time_ms: 20, max_yield_time_ms: 20 },
          process.cwd(),
          call.signal,
          (update) => {
            if (update.session_id !== undefined) call.ownShell(update.session_id);
          },
        );
        if (result.session_id !== undefined) call.ownShell(result.session_id);
        return result;
      }),
    ],
  });
  try {
    const completed = await host.execute("text(await tools.shell({}));");
    const firstText = completed.contentItems[0];
    expect(firstText?.type).toBe("input_text");
    const first = JSON.parse(firstText?.type === "input_text" ? firstText.text : "{}")
      .session_id as number;
    expect(shells.hasSession(first)).toBe(true);
    const pending = await host.execute(
      "text(await tools.shell({})); await yield_control(); await new Promise(() => {});",
    );
    const secondText = pending.contentItems[0];
    const second = JSON.parse(secondText?.type === "input_text" ? secondText.text : "{}")
      .session_id as number;
    expect(shells.hasSession(second)).toBe(true);
    await host.terminate(pending.cellId);
    await expect.poll(() => shells.listSessions().map((s) => s.id)).toEqual([first]);
    const poll = await shells.write({ session_id: first, yield_time_ms: 0 });
    expect(poll.session_id).toBe(first);
    await host.shutdown();
    await expect.poll(() => shells.listSessions()).toEqual([]);
  } finally {
    await host.shutdown();
    await shells.shutdown();
  }
});

test("freeform tools receive raw strings and unawaited delegates are cancelled on module completion", async () => {
  const started = deferred<AbortSignal>();
  const host = runtime({
    tools: [
      {
        name: "patch",
        kind: "freeform",
        description: "test freeform",
        invoke: async (input) => input,
      },
      tool("unfinished", async (_input, { signal }) => {
        started.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }),
    ],
  });
  expect((await host.execute('text(await tools.patch("raw patch\\ntext"));')).contentItems).toEqual(
    [{ type: "input_text", text: "raw patch\ntext" }],
  );
  const response = host.execute(
    'tools.unfinished({}); await new Promise(r => setTimeout(r, 50)); exit(); text("unreachable");',
  );
  const signal = await started.promise;
  expect(await response).toMatchObject({ kind: "result", contentItems: [] });
  await expect.poll(() => signal.aborted).toBe(true);
});

test("aborting a wait explicitly cancels the cell and its pending delegate", async () => {
  const entered = deferred<AbortSignal>();
  const host = runtime({
    tools: [
      tool("pending", async (_input, { signal }) => {
        entered.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }),
    ],
  });
  const first = await host.execute('// @exec: {"yield_time_ms":0}\nawait tools.pending({});');
  const nestedSignal = await entered.promise;
  const abort = new AbortController();
  const pending = host.wait(first.cellId, 10_000, abort.signal);
  const failure = expect(pending).rejects.toThrow(/abort/i);
  abort.abort();
  await failure;
  expect(nestedSignal.aborted).toBe(true);
  await expect.poll(async () => (await host.wait(first.cellId, 0)).missingCell).toBe(true);
});

test("each execution snapshots its enabled tools while sharing native stored values", async () => {
  const host = runtime();
  const before = tool("before", async () => "old capability");
  const after = tool("after", async () => "new capability");
  const first = await host.execute(
    'store("shared", 42); text(await tools.before({}));',
    undefined,
    [before],
  );
  expect(first.contentItems).toEqual([{ type: "input_text", text: "old capability" }]);
  const later = await host.execute(
    'text(load("shared")); text(ALL_TOOLS.map(t => t.name)); text(await tools.after({}));',
    undefined,
    [after],
  );
  expect(later.contentItems).toEqual([
    { type: "input_text", text: "42" },
    { type: "input_text", text: '["after"]' },
    { type: "input_text", text: "new capability" },
  ]);
});
