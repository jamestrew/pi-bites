import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { appendAutoModeUsageRecord } from "./usage.js";
import { complete, createAutoModeHarness, response, rmRequest, tempDirs } from "./test/support.js";

vi.mock("./usage.js", () => ({ appendAutoModeUsageRecord: vi.fn(() => Promise.resolve()) }));

function toolResponse(path: string, id = "inspect") {
  return response("", {
    content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
    stopReason: "toolUse",
  });
}

test("Guardian can inspect the current script and retain the complete successful review", async () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-read-"));
  tempDirs.push(root);
  writeFileSync(join(root, "push_feature_source.py"), 'print("HARMLESS_SCRIPT")\n');
  const { controller, ctx } = createAutoModeHarness();
  ctx.sessionManager.getCwd = () => root;
  const request = { ...rmRequest("python push_feature_source.py"), execution: { cwd: root } };
  complete
    .mockResolvedValueOnce(toolResponse("push_feature_source.py"))
    .mockResolvedValueOnce(response('{"outcome":"allow"}'))
    .mockResolvedValueOnce(response('{"outcome":"deny"}'));
  await expect(controller.review(request, ctx as any)).resolves.toMatchObject({ outcome: "allow" });
  const investigated = complete.mock.calls[1]![1];
  expect(JSON.stringify(investigated)).toContain("HARMLESS_SCRIPT");
  expect(investigated.messages.at(-1)).toMatchObject({
    role: "toolResult",
    toolName: "read",
    toolCallId: "inspect",
    isError: false,
  });
  expect(appendAutoModeUsageRecord).toHaveBeenCalledTimes(2);
  await controller.review(request, ctx as any);
  expect(complete.mock.calls[2]![1].messages).toHaveLength(5);
  expect(JSON.stringify(complete.mock.calls[2]![1])).toContain("HARMLESS_SCRIPT");
});

function readFixture() {
  const root = mkdtempSync(join(tmpdir(), "guardian-read-"));
  tempDirs.push(root);
  const harness = createAutoModeHarness();
  harness.ctx.sessionManager.getCwd = () => root;
  const request = { ...rmRequest("python script.py"), execution: { cwd: root } };
  return { ...harness, root, request };
}

test.each(["outside", "symlink", "secret", "binary", "large", "directory"])(
  "Guardian does not disclose %s reads",
  async (kind) => {
    const { root, controller, ctx, request } = readFixture();
    const outside = mkdtempSync(join(tmpdir(), "guardian-private-"));
    tempDirs.push(outside);
    writeFileSync(join(outside, "private.txt"), "PRIVATE_MARKER");
    let path = "script.py";
    if (kind === "outside") path = join(outside, "private.txt");
    if (kind === "symlink") {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(join(outside, "private.txt"), join(root, path));
    }
    if (kind === "secret") {
      path = ".env";
      writeFileSync(join(root, path), "PRIVATE_MARKER");
    }
    if (kind === "binary") writeFileSync(join(root, path), Buffer.from([0, 1, 2, 255]));
    if (kind === "large") writeFileSync(join(root, path), "PRIVATE_MARKER".repeat(30_000));
    if (kind === "directory") path = ".";
    complete
      .mockResolvedValueOnce(toolResponse(path))
      .mockResolvedValueOnce(response('{"outcome":"deny"}'));
    await controller.review(request, ctx as any);
    const evidence = complete.mock.calls[1]![1].messages.at(-1)!;
    expect(evidence).toMatchObject({ role: "toolResult", isError: true });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_MARKER");
  },
);

test("three investigation rounds reserve a final tools-disabled assessment", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "SCRIPT");
  for (let round = 0; round < 3; round++) {
    complete.mockResolvedValueOnce(
      response("", {
        stopReason: "toolUse",
        content: [0, 1].map((index) => ({
          type: "toolCall",
          id: "read-" + round + "-" + index,
          name: "read",
          arguments: { path: "script.py" },
        })),
      }),
    );
  }
  complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await controller.review(request, ctx as any);
  expect(complete.mock.calls[3]![1].tools).toBeUndefined();
  expect(complete.mock.calls[3]![1].messages.filter((m) => m.role === "toolResult")).toHaveLength(
    6,
  );
  expect(appendAutoModeUsageRecord).toHaveBeenCalledTimes(4);
});

test("unknown tool batches fail closed without committing partial investigation", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "SCRIPT");
  complete.mockResolvedValueOnce(
    response("", {
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "read", name: "read", arguments: { path: "script.py" } },
        { type: "toolCall", id: "shell", name: "bash", arguments: { command: "echo hacked" } },
      ],
    }),
  );
  await expect(controller.review(request, ctx as any)).rejects.toThrow("Invalid reviewer tool");
  complete.mockResolvedValueOnce(response('{"outcome":"deny"}'));
  await controller.review(request, ctx as any);
  expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
});

test("a cancelled ignored provider cannot start the next investigation step", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "SCRIPT");
  const abort = new AbortController();
  let finish!: (value: any) => void;
  complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = controller.review(request, { ...ctx, signal: abort.signal } as any);
  const rejected = expect(pending).rejects.toThrow();
  abort.abort(new Error("cancelled"));
  await rejected;
  finish(toolResponse("script.py"));
  await vi.waitFor(() => expect(appendAutoModeUsageRecord).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledOnce();
});

test("child inspection uses its execution directory without promoting its evidence", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "CHILD_ONLY_SCRIPT");
  complete
    .mockResolvedValueOnce(toolResponse("script.py"))
    .mockResolvedValueOnce(response('{"outcome":"allow"}'))
    .mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await controller.review({ ...request, subagentContext: "CHILD" }, ctx as any);
  expect(JSON.stringify(complete.mock.calls[1]![1])).toContain("CHILD_ONLY_SCRIPT");
  await controller.review(request, ctx as any);
  expect(JSON.stringify(complete.mock.calls[2]![1])).not.toContain("CHILD_ONLY_SCRIPT");
});

test("a symlinked owning workspace admits its regular current script", async () => {
  const { root, controller, ctx, request } = readFixture();
  const { symlinkSync } = await import("node:fs");
  const alias = join(root, "workspace-alias");
  const actual = mkdtempSync(join(tmpdir(), "guardian-workspace-"));
  tempDirs.push(actual);
  symlinkSync(actual, alias);
  ctx.sessionManager.getCwd = () => alias;
  request.execution.cwd = alias;
  writeFileSync(join(actual, "script.py"), "CURRENT_SCRIPT");
  complete
    .mockResolvedValueOnce(toolResponse("script.py"))
    .mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await controller.review(request, ctx as any);
  expect(complete.mock.calls[1]![1].messages.at(-1)).toMatchObject({ isError: false });
  expect(JSON.stringify(complete.mock.calls[1]![1])).toContain("CURRENT_SCRIPT");
});

test("read result pages and the entire investigation obey byte limits including framing", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), ("x".repeat(120) + "\n").repeat(300));
  complete
    .mockResolvedValueOnce(
      response("", {
        stopReason: "toolUse",
        content: Array.from({ length: 6 }, (_, index) => ({
          type: "toolCall",
          id: "page-" + index,
          name: "read",
          arguments: { path: "script.py" },
        })),
      }),
    )
    .mockResolvedValueOnce(response('{"outcome":"deny"}'));
  await controller.review(request, ctx as any);
  const results = complete.mock.calls[1]![1].messages.filter(
    (message) => message.role === "toolResult",
  );
  const sizes = results.map((message) => Buffer.byteLength(JSON.stringify(message.content)));
  // Content framing is separate model-message overhead; text allowance is hard.
  const texts = results.map((message) => (message.content[0] as any).text as string);
  expect(Math.max(...texts.map((text) => Buffer.byteLength(text)))).toBeLessThanOrEqual(8192);
  expect(texts.reduce((size, text) => size + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(
    32768,
  );
  expect(sizes).toHaveLength(6);
  expect(texts[0]).toContain("omitted_approx_tokens");
  expect(complete.mock.calls[1]![1].tools).toBeUndefined();
});

test("a command workdir cannot expand the owning workspace's read capability", async () => {
  const { controller, ctx, request } = readFixture();
  const outside = mkdtempSync(join(tmpdir(), "guardian-other-workdir-"));
  tempDirs.push(outside);
  writeFileSync(join(outside, "script.py"), "OUTSIDE_WORKSPACE_SECRET");
  request.execution.cwd = outside;
  complete
    .mockResolvedValueOnce(toolResponse("script.py"))
    .mockResolvedValueOnce(response('{"outcome":"deny"}'));
  await controller.review(request, ctx as any);
  const result = complete.mock.calls[1]![1].messages.at(-1)!;
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).not.toContain("OUTSIDE_WORKSPACE_SECRET");
});

test("investigation never dereferences an expired extension ctx", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "CURRENT_SCRIPT");
  let expired = false;
  const ephemeral = Object.fromEntries(
    Object.entries(ctx).map(([key, value]) => [
      key,
      {
        get() {
          if (expired) throw new Error("expired ctx getter: " + key);
          return value;
        },
      },
    ]),
  );
  const guardedCtx = Object.defineProperties({}, ephemeral);
  complete
    .mockImplementationOnce(async () => {
      expired = true;
      return toolResponse("script.py");
    })
    .mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await expect(controller.review(request, guardedCtx as any)).resolves.toMatchObject({
    outcome: "allow",
  });
  expect(JSON.stringify(complete.mock.calls[1]![1])).toContain("CURRENT_SCRIPT");
});

test.each(["duplicate", "invalid-range", "tool-after-final"])(
  "malformed %s investigation fails without warming parent history",
  async (kind) => {
    const { root, controller, ctx, request } = readFixture();
    writeFileSync(join(root, "script.py"), "CURRENT_SCRIPT");
    const call = {
      type: "toolCall",
      id: "inspect",
      name: "read",
      arguments: { path: "script.py" },
    };
    complete.mockResolvedValueOnce(
      response('{"outcome":"allow"}', {
        stopReason: kind === "tool-after-final" ? "stop" : "toolUse",
        content:
          kind === "duplicate"
            ? [call, call]
            : [
                {
                  ...call,
                  arguments: {
                    ...call.arguments,
                    ...(kind === "invalid-range" ? { offset: 1.5 } : {}),
                  },
                },
              ],
      }),
    );
    await expect(controller.review(request, ctx as any)).rejects.toThrow();
    complete.mockResolvedValueOnce(response('{"outcome":"deny"}'));
    await controller.review(request, ctx as any);
    expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
  },
);

test("declared read schema rejects coercible boolean ranges before any follow-up", async () => {
  const { root, controller, ctx, request } = readFixture();
  writeFileSync(join(root, "script.py"), "CURRENT_SCRIPT");
  complete
    .mockResolvedValueOnce(
      response("", {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "invalid",
            name: "read",
            arguments: { path: "script.py", offset: true },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await expect(controller.review(request, ctx as any)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});
