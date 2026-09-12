import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi, test as nativeTest } from "vitest";
import { createBashGateHarness } from "../bash-gate/test/harness.js";
import { createApplyPatchTool } from "./apply-patch/tool.js";
import { createExecCommandTool } from "./exec/command-tool.js";
import { createExecSessionManager } from "./exec/session-manager.js";
import { createWriteStdinTool } from "./exec/write-stdin-tool.js";
import { createViewImageTool } from "./view-image/tool.js";
import {
  createWebRunTool,
  type CreateWebRunToolOptions,
  type WebRunNativeInput,
} from "./web-run/tool.js";
import { getCodeModeHostPath } from "./code-mode/binary.js";
import { NestedToolBridge } from "./code-mode/nested-tools.js";
import { nativeTools, contract } from "./code-mode/contracts.js";
import { CodeModeRuntime } from "./code-mode/runtime.js";
import type { RuntimeResponse } from "./code-mode/types.js";
import type { CodexAdapterConfig } from "../config.js";

let binary = process.env.PI_BITES_TEST_CODE_MODE_HOST;
try {
  binary ??= getCodeModeHostPath();
} catch {
  /* manual dependency */
}
const built = join(import.meta.dirname, "vendor/code-mode/target/release/codex-code-mode-host");
if (!binary && existsSync(built)) binary = built;
const test = nativeTest.skipIf(!binary);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function setup(
  web: Partial<CreateWebRunToolOptions> = {},
  gateOptions: Parameters<typeof createBashGateHarness>[4] = {},
  autoMode?: Parameters<typeof createBashGateHarness>[2],
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-nested-"));
  const gate = createBashGateHarness([], false, autoMode, true, gateOptions);
  gate.ui.select.mockResolvedValue("Allow");
  const sessions = createExecSessionManager({ minEmptyWriteYieldTimeMs: 250 });
  const config: CodexAdapterConfig = { webSearchProviders: ["work"] };
  const owned = {
    exec_command: createExecCommandTool(sessions),
    write_stdin: createWriteStdinTool(sessions),
    apply_patch: createApplyPatchTool(),
    view_image: createViewImageTool(),
    web_run: createWebRunTool({ getConfig: () => config, ...web }),
  };
  let stale = false;
  const model = {
    provider: "work",
    id: "gpt-6",
    api: "openai-responses",
    baseUrl: "https://work.example/v1",
    input: ["text", "image"],
  };
  const dependencies = {
    ...gate.ctx,
    cwd,
    model,
    signal: new AbortController().signal,
    isProjectTrusted: () => true,
    modelRegistry: {
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({
        ok: true,
        headers: { Authorization: "Bearer work-key" },
      }),
    },
  };
  const ctx = Object.fromEntries(Object.keys(dependencies).map((key) => [key, undefined]));
  for (const [key, value] of Object.entries(dependencies))
    Object.defineProperty(ctx, key, {
      get() {
        if (stale) throw new Error(`stale ctx.${key}`);
        return value;
      },
    });
  const bridge = new NestedToolBridge(owned, gate.gate, () => config);
  bridge.capture(ctx as never);
  const runtime = new CodeModeRuntime({
    binary,
    tools: nativeTools(bridge.tools()),
    shells: sessions,
  });
  cleanup.push(async () => {
    await runtime.shutdown();
    bridge.clear();
    await sessions.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    runtime,
    bridge,
    sessions,
    cwd,
    gate,
    owned,
    config,
    model,
    expire: () => {
      stale = true;
    },
  };
}
function values(response: RuntimeResponse): unknown[] {
  expect(response.errorText).toBeUndefined();
  return response.contentItems
    .filter((item) => item.type === "input_text")
    .map((item) => JSON.parse(item.text));
}

test("denial and cancelled approval never launch processes", async () => {
  const { runtime, sessions, gate, cwd } = setup();
  gate.ui.select.mockResolvedValueOnce("Deny").mockResolvedValueOnce("Allow");
  const result = await runtime.execute(`text(await Promise.allSettled([
    tools.exec_command({cmd:"touch denied",login:false}),
    tools.exec_command({cmd:"touch allowed",login:false})]));`);
  const [settled] = values(result) as { status: string }[][];
  expect(settled!.map((item) => item.status)).toEqual(["rejected", "fulfilled"]);
  expect(existsSync(join(cwd, "denied"))).toBe(false);
  expect(existsSync(join(cwd, "allowed"))).toBe(true);
  const records = gate.pi.appendEntry.mock.calls
    .filter(([kind]) => kind === "pi-bites:shell-authorization")
    .map(([, entry]) => entry as { toolCallId: string });
  expect(records).toHaveLength(2);
  expect(new Set(records.map((entry) => entry.toolCallId)).size).toBe(2);
  let allow!: (value: string) => void;
  gate.ui.select.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const pending = await runtime.execute(
    '// @exec: {"yield_time_ms":30}\nawait tools.exec_command({cmd:"touch late",login:false});',
  );
  await expect.poll(() => !!allow).toBe(true);
  await runtime.terminate(pending.cellId);
  allow("Allow");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(existsSync(join(cwd, "late"))).toBe(false);
  expect(sessions.listSessions()).toEqual([]);
});

test("explicit cell cancellation terminates only its owned shells; completed cells leave resumable sessions", async () => {
  const { runtime, sessions } = setup();
  const unrelated = await runtime.execute(
    'text(await tools.exec_command({cmd:"sleep 60",login:false,yield_time_ms:250}));',
  );
  const [other] = values(unrelated) as { session_id: number }[];
  const owned = await runtime.execute(
    'text(await tools.exec_command({cmd:"sleep 60",login:false,yield_time_ms:250})); await yield_control(); await new Promise(r => setTimeout(r,60000));',
  );
  const [shell] = values(owned) as { session_id: number }[];
  expect(sessions.listSessions().map((s) => s.id)).toEqual([other!.session_id, shell!.session_id]);
  await runtime.terminate(owned.cellId);
  await expect.poll(() => sessions.listSessions().map((s) => s.id)).toEqual([other!.session_id]);
  await runtime.shutdown();
  await expect.poll(() => sessions.listSessions()).toEqual([]);
});

test("TTY input resumes a shell without new command authorization", async () => {
  const { runtime, gate } = setup();
  const cmd = 'read line; printf "got:%s" "$line"';
  const [shell] = values(
    await runtime.execute(
      `text(await tools.exec_command({cmd:${JSON.stringify(cmd)},tty:true,login:false,yield_time_ms:250}));`,
    ),
  ) as { session_id: number }[];
  const approvals = gate.ui.select.mock.calls.length;
  const [done] = values(
    await runtime.execute(
      `text(await tools.write_stdin({session_id:${shell!.session_id},chars:"hello\\n",yield_time_ms:1000}));`,
    ),
  ) as { output: string; exit_code: number }[];
  expect(done).toMatchObject({ exit_code: 0, output: expect.stringContaining("got:hello") });
  expect(gate.ui.select.mock.calls.length).toBe(approvals);
});

test("nested arguments reject aliases, hidden request configuration, and invalid numeric inputs before authorization", async () => {
  const { runtime, gate } = setup();
  const result = await runtime.execute(`text(await Promise.allSettled([
    tools.exec_command({command:"touch invalid"}), tools.exec_command({cmd:"touch invalid",yield_time_ms:0.5}),
    tools.write_stdin({session_id:1,chars:42}), tools.web_run({settings:{search_context_size:"high"}}),
    tools.web_run({search_query:[{q:"x",recency:9007199254740992}]}), tools.view_image({path:"x",detail:"original"}),
    tools.apply_patch({input:"not a string"})]));`);
  const [settled] = values(result) as { status: string }[][];
  expect(settled!.map((item) => item.status)).toEqual(Array(7).fill("rejected"));
  expect(gate.ui.select).not.toHaveBeenCalled();
});

test("nested shells preserve native nonzero results and explicit zero/small output budgets", async () => {
  const { runtime, bridge, expire } = setup();
  expire();
  const result = await runtime.execute(
    `text(await tools.exec_command({cmd:"printf failure; exit 7", login:false, max_output_tokens:0}));`,
  );
  expect(values(result)).toEqual([
    expect.objectContaining({ output: "", exit_code: 7, original_token_count: 2 }),
  ]);
  expect(bridge.traces.forCell(result.cellId)[0]?.result?.details).toMatchObject({ exit_code: 7 });
  expect(
    values(
      await runtime.execute(
        `text(await tools.exec_command({cmd:"printf abcdef",login:false,max_output_tokens:1}));`,
      ),
    ),
  ).toEqual([expect.objectContaining({ output: "cdef", exit_code: 0 })]);
});

test("shell waits honor deadlines despite ongoing output and resume independently of cells", async () => {
  const { runtime } = setup();
  const start = Date.now();
  const first = await runtime.execute(
    `text(await tools.exec_command({cmd:"for x in 1 2 3 4 5 6 7 8 9 10; do printf x; sleep .1; done",login:false,yield_time_ms:250}));`,
  );
  const [shell] = values(first) as { session_id: number; exit_code?: number; output: string }[];
  expect(shell!.session_id).toBeTypeOf("number");
  expect(shell!.exit_code).toBeUndefined();
  expect(Date.now() - start).toBeLessThan(950);
  const next = await runtime.execute(
    `text(await tools.write_stdin({session_id:${shell!.session_id},yield_time_ms:1500}));`,
  );
  const [done] = values(next) as { output: string; exit_code: number }[];
  expect(done!.exit_code).toBe(0);
  expect(shell!.output + done!.output).toBe("xxxxxxxxxx");
});

test("freeform patches share file mutation queues across cells and preserve partial failures in traces", async () => {
  const { runtime, bridge, cwd, expire } = setup();
  expire();
  const target = join(cwd, "shared.txt");
  writeFileSync(target, "one\ntwo\n");
  const patch = (from: string, to: string) =>
    `*** Begin Patch\n*** Update File: shared.txt\n@@\n-${from}\n+${to}\n*** End Patch`;
  let cells: RuntimeResponse[] = [];
  await withFileMutationQueue(target, async () => {
    cells = await Promise.all(
      [patch("one", "ONE"), patch("two", "TWO")].map((input) =>
        runtime.execute(
          `// @exec: {"yield_time_ms":40}\ntext(await tools.apply_patch(${JSON.stringify(input)}));`,
        ),
      ),
    );
    expect(cells.map((cell) => cell.kind)).toEqual(["yielded", "yielded"]);
    expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
  });
  for (const cell of cells) expect(values(await runtime.wait(cell.cellId))).toEqual([{}]);
  expect(readFileSync(target, "utf8")).toBe("ONE\nTWO\n");
  const partial =
    "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch";
  const failed = await runtime.execute(`await tools.apply_patch(${JSON.stringify(partial)});`);
  expect(failed.errorText).toContain("partially failed");
  expect(readFileSync(join(cwd, "created.txt"), "utf8")).toBe("created\n");
  expect(bridge.traces.forCell(failed.cellId)).toMatchObject([
    {
      state: "error",
      result: {
        details: {
          status: "partial_failure",
          render: { status: "partial_failure", failedTargets: ["missing.txt"] },
        },
      },
    },
  ]);
});

test("nested web calls retain navigation and citations while enforcing execution-time route policy", async () => {
  const requests: WebRunNativeInput[] = [];
  const { runtime, bridge, owned, config, expire } = setup({
    runNative: async (request) => {
      requests.push(request);
      return JSON.stringify({
        output_text: "web result",
        search_results: [{ ref_id: "source1", url: "https://example.org/page" }],
      });
    },
  });
  expire();
  const result = await runtime.execute(
    'text(await tools.web_run({search_query:[{q:"explicit"}]})); text(await tools.web_run({open:[{ref_id:"source1"}]}));',
  );
  expect(result.contentItems).toEqual([
    { type: "input_text", text: "web result" },
    { type: "input_text", text: "web result" },
  ]);
  expect(requests[0]?.params).toEqual({
    search_query: [{ q: "explicit" }],
    id: expect.any(String),
    model: "gpt-6",
    max_output_tokens: 8000,
  });
  expect(requests[1]?.params.id).toBe(requests[0]?.params.id);
  expect(owned.web_run.transformCitations("citesource1")).toBe(
    "[source](<https://example.org/page>)",
  );
  config.webSearchProviders = [];
  expect(
    (await runtime.execute('await tools.web_run({search_query:[{q:"forbidden"}]});')).errorText,
  ).toContain("unavailable");
  expect(requests).toHaveLength(2);
  expect(bridge.tools().map((tool) => tool.name)).not.toContain("web_run");
  bridge.clear();
  expect(owned.web_run.transformCitations("citesource1")).toBe("[web source]");
});

test("native image results are emitted explicitly without duplicate model output or base64 in text traces", async () => {
  const { runtime, bridge, cwd, expire } = setup();
  expire();
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC";
  writeFileSync(join(cwd, "image.png"), Buffer.from(data, "base64"));
  const silent = await runtime.execute('await tools.view_image({path:"image.png"});');
  expect(silent.contentItems).toEqual([]);
  expect(bridge.traces.forCell(silent.cellId)[0]?.result?.content).toEqual([
    { type: "image", mimeType: "image/png", data },
  ]);
  const emitted = await runtime.execute('image(await tools.view_image({path:"image.png"}));');
  expect(emitted.contentItems).toEqual([
    { type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "original" },
  ]);
  expect(
    (await runtime.execute('await tools.view_image({path:"missing.png"});')).errorText,
  ).toBeTruthy();
});

test("clearing a bridge invalidates pending authorization and cannot revive cleared traces", async () => {
  const { runtime, bridge, gate, cwd, expire } = setup();
  let allow!: (value: string) => void;
  gate.ui.select.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const pending = await runtime.execute(
    '// @exec: {"yield_time_ms":30}\nawait tools.exec_command({cmd:"touch obsolete",login:false});',
  );
  await expect.poll(() => !!allow).toBe(true);
  expire();
  bridge.clear();
  allow("Allow");
  const result = await runtime.wait(pending.cellId);
  expect(result.errorText).toBeTruthy();
  expect(existsSync(join(cwd, "obsolete"))).toBe(false);
  expect(bridge.traces.forCell(pending.cellId)).toEqual([]);
});

test("cancelled patches waiting for a file queue never mutate after the queue is released", async () => {
  const { runtime, cwd } = setup();
  const target = join(cwd, "queued.txt");
  writeFileSync(target, "before\n");
  await withFileMutationQueue(target, async () => {
    const patch =
      "*** Begin Patch\n*** Update File: queued.txt\n@@\n-before\n+after\n*** End Patch";
    const pending = await runtime.execute(
      `// @exec: {"yield_time_ms":40}\nawait tools.apply_patch(${JSON.stringify(patch)});`,
    );
    expect(pending.kind).toBe("yielded");
    await runtime.terminate(pending.cellId);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(readFileSync(target, "utf8")).toBe("before\n");
});

test("retained traces are bounded without truncating the values returned to JavaScript", async () => {
  const { runtime, bridge } = setup({
    runNative: async () => JSON.stringify({ output_text: "x".repeat(100000) }),
  });
  const result = await runtime.execute(
    'let length; for(let i=0;i<130;i++) length=(await tools.web_run({search_query:[{q:"x"}]})).length; text(length);',
  );
  expect(values(result)).toEqual([100000]);
  const traces = bridge.traces.forCell(result.cellId);
  expect(traces).toHaveLength(128);
  expect(traces.every((trace) => trace.state === "completed")).toBe(true);
  expect(JSON.stringify(traces).length).toBeLessThan(3 * 1024 * 1024);
});

test("web route errors reject without fallback and model capabilities are rechecked after yielding", async () => {
  let requests = 0;
  const { runtime, bridge, model } = setup({
    runNative: async () => {
      requests++;
      throw new Error("HTTP 403");
    },
  });
  expect(
    (await runtime.execute('await tools.web_run({search_query:[{q:"x"}]});')).errorText,
  ).toContain("no other provider was tried");
  expect(requests).toBe(1);
  const cell = await runtime.execute(
    'await yield_control(); await new Promise(r=>setTimeout(r,100)); await tools.view_image({path:"x"});',
  );
  model.input = ["text"];
  expect((await runtime.wait(cell.cellId)).errorText).toContain("unavailable");
  expect(bridge.tools().map((tool) => tool.name)).not.toContain("view_image");
});

test("unhandled aggregate denial cancels sibling approval before a late allow can launch", async () => {
  const { runtime, gate, cwd } = setup();
  const denied = Promise.withResolvers<string>();
  const sibling = Promise.withResolvers<string>();
  gate.ui.select
    .mockImplementationOnce(() => denied.promise)
    .mockImplementationOnce(() => sibling.promise);
  const pending = await runtime.execute(
    '// @exec: {"yield_time_ms":30}\nawait Promise.all([tools.exec_command({cmd:"touch denied",login:false}), tools.exec_command({cmd:"touch sibling",login:false})]);',
  );
  await expect.poll(() => gate.ui.select.mock.calls.length).toBe(1);
  denied.resolve("Deny");
  expect((await runtime.wait(pending.cellId)).errorText).toContain("denied");
  sibling.resolve("Allow");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(existsSync(join(cwd, "denied"))).toBe(false);
  expect(existsSync(join(cwd, "sibling"))).toBe(false);
});

test("queued real commands recheck a shared session allowance and safe work proceeds", async () => {
  const { runtime, gate, cwd } = setup(
    {},
    { bashGate: { rules: [{ cmd: "touch", reason: "smoke" }] } },
  );
  const choice = Promise.withResolvers<string>();
  gate.ui.select.mockImplementationOnce(() => choice.promise);
  const pending = await runtime.execute(
    '// @exec: {"yield_time_ms":30}\ntext(await Promise.allSettled([tools.exec_command({cmd:"touch first",login:false}), tools.exec_command({cmd:"touch second",login:false})]));',
  );
  await expect.poll(() => gate.ui.select.mock.calls.length).toBe(1);
  expect(
    values(
      await runtime.execute(
        'text(await tools.exec_command({cmd:"printf independent",login:false}));',
      ),
    ),
  ).toEqual([expect.objectContaining({ output: "independent" })]);
  choice.resolve('Allow for session ("touch")');
  expect(
    (values(await runtime.wait(pending.cellId))[0] as { status: string }[]).map((r) => r.status),
  ).toEqual(["fulfilled", "fulfilled"]);
  expect(gate.ui.select).toHaveBeenCalledOnce();
  expect(existsSync(join(cwd, "first"))).toBe(true);
  expect(existsSync(join(cwd, "second"))).toBe(true);
});

test.each(["allow", "deny", "review-error", "escalation-error", "cancel"] as const)(
  "real nested Auto Mode %s settles authorization before process creation",
  async (outcome) => {
    const pendingReview = Promise.withResolvers<{ outcome: "allow" }>();
    const review = vi.fn(async () => {
      if (outcome === "review-error") throw new Error("review unavailable");
      if (outcome === "cancel") return pendingReview.promise;
      return { outcome: outcome === "allow" ? ("allow" as const) : ("deny" as const) };
    });
    const { runtime, gate, cwd, expire } = setup({}, {}, { isEnabled: () => true, review });
    gate.ui.select.mockResolvedValue("Deny");
    if (outcome === "escalation-error")
      gate.ui.select.mockRejectedValue(new Error("UI unavailable"));
    const pending = runtime.execute(
      '// @exec: {"yield_time_ms":30}\nawait tools.exec_command({cmd:"touch reviewed",login:false});',
    );
    expire();
    let result = await pending;
    if (outcome === "cancel") {
      await expect.poll(() => review.mock.calls.length).toBe(1);
      await runtime.terminate(result.cellId);
      pendingReview.resolve({ outcome: "allow" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    } else {
      if (result.kind === "yielded") result = await runtime.wait(result.cellId);
      if (outcome === "allow") expect(result.errorText).toBeUndefined();
      else expect(result.errorText).toBeTruthy();
    }
    expect(existsSync(join(cwd, "reviewed"))).toBe(outcome === "allow");
    expect(review).toHaveBeenCalledOnce();
    expect(gate.pi.appendEntry.mock.calls.map(([, entry]) => entry)).toEqual([
      expect.objectContaining({ status: outcome === "allow" ? "reviewer-approved" : "blocked" }),
    ]);
  },
);

test("the real host and bundled web client carry navigation and citations only to the selected route", async () => {
  const { createServer } = await import("node:http");
  const requests: { id: string; commands: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output: "native citation citeturn0search0",
          results: [{ ref_id: "turn0search0", url: "https://example.org/source" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const { runtime, bridge, model, owned, config, expire } = setup();
  model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  expire();
  const discovered = values(await runtime.execute("text(ALL_TOOLS);"))[0] as {
    name: string;
    description: string;
  }[];
  expect(discovered).toHaveLength(5);
  for (const entry of discovered) {
    expect(entry.description).toBe(
      contract.tools.find((tool) => tool.name === entry.name)!.runtime_description,
    );
    expect(entry.description.match(/declare const tools:/g)).toHaveLength(1);
  }
  expect(requests).toEqual([]);
  const commands = [
    { search_query: [{ q: "explicit query" }] },
    { open: [{ ref_id: "turn0search0" }] },
    { click: [{ ref_id: "turn0search0", id: 1 }] },
    { find: [{ ref_id: "turn0search0", pattern: "source" }] },
    { image_query: [{ q: "sample" }] },
  ];
  for (const command of commands) {
    const result = await runtime.execute(`text(await tools.web_run(${JSON.stringify(command)}));`);
    expect(result.errorText).toBeUndefined();
    expect(result.contentItems).toEqual([
      { type: "input_text", text: "native citation citeturn0search0" },
    ]);
  }
  expect(requests.map((request) => request.commands)).toEqual(commands);
  expect(new Set(requests.map((request) => request.id)).size).toBe(1);
  expect(owned.web_run.transformCitations("citeturn0search0")).toBe(
    "[source](<https://example.org/source>)",
  );
  config.webSearchProviders = [];
  expect(
    (await runtime.execute('await tools.web_run({search_query:[{q:"blocked"}]});')).errorText,
  ).toContain("unavailable");
  expect(requests).toHaveLength(5);
  const unavailable = values(
    await runtime.execute("text(ALL_TOOLS);", undefined, nativeTools(bridge.tools())),
  )[0] as { name: string }[];
  expect(unavailable.map((tool) => tool.name)).not.toContain("web_run");
});
