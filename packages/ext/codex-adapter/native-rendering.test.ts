import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNativeRendering } from "./native-rendering.js";
import { setup, textOf } from "./test/native-session.js";

test("native renderer restores command/patch/error rows, image fallback and script-only output", async () => {
  const h = await setup();
  const script = await h.run(`text('standalone');`);
  const nested = await h.run(
    `await tools.exec_command({cmd:'printf visible',login:false}); throw new Error('render failure');`,
  );
  const tool = h.session.getToolDefinition("codemode")!;
  const theme = {
    bold: (s: string) => s,
    fg: (_role: string, s: string) => s,
    bg: (_role: string, s: string) => s,
  };
  const render = (result: any, expanded: boolean) =>
    tool.renderResult!(
      JSON.parse(JSON.stringify(result.result)),
      { expanded, isPartial: false },
      theme as never,
      {
        args: { code: "" },
        toolCallId: "restored",
        invalidate() {},
        lastComponent: undefined,
        state: {},
        cwd: h.cwd,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: result.isError,
      },
    )
      .render(80)
      .join("\n");
  expect(render(script, false)).toContain("standalone");
  expect(render(nested, false)).toContain("exec_command");
  expect(render(nested, true)).toContain("render failure");
  expect(JSON.stringify(nested.result.details)).not.toContain("traces");
  const patch = "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch";
  const patched = await h.run(`text(await tools.apply_patch(${JSON.stringify(patch)}));`);
  for (const expanded of [false, true]) {
    // Native script output remains visible alongside the owned diff renderer.
    expect(render(patched, expanded)).toContain("apply_patch");
    expect(render(patched, expanded)).toContain('"status":"success"');
    expect(render(patched, expanded)).toContain("rendered.txt");
  }
  writeFileSync(
    join(h.cwd, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const pictured = await h.run(`image(await tools.view_image({path:'pixel.png'}));`);
  for (const expanded of [false, true])
    expect(render(pictured, expanded)).toContain("[Image: [image/png] 2x1]");
});

const plainTheme = {
  bold: (s: string) => s,
  fg: (_role: string, s: string) => s,
  bg: (_role: string, s: string) => s,
};
function rendered(
  h: Awaited<ReturnType<typeof setup>>,
  event: any,
  expanded = false,
  width = 100,
  theme = plainTheme,
) {
  return h.session.getToolDefinition("codemode")!.renderResult!(
    JSON.parse(JSON.stringify(event.result ?? event.partialResult)),
    { expanded, isPartial: event.type === "tool_execution_update" },
    theme as never,
    {
      args: { code: "" },
      toolCallId: "restored",
      state: {},
      lastComponent: undefined,
      invalidate() {},
      cwd: "/not-the-launch-directory",
      executionStarted: true,
      argsComplete: true,
      isPartial: event.type === "tool_execution_update",
      isError: event.isError ?? false,
      expanded,
      showImages: false,
    },
  )
    .render(width)
    .map((line) => line.trimEnd());
}

test("native hybrid shows commands and their outputs without script emission, with native JS and statuses", async () => {
  const h = await setup();
  const code = `await Promise.all([tools.exec_command({cmd:'printf first',login:false}),tools.exec_command({cmd:'true',login:false}),tools.exec_command({cmd:'printf failed; exit 7',login:false})]);`;
  const end = await h.run(code);
  const content = textOf(end);
  expect(content).not.toContain("first");
  expect(content).not.toContain("failed");
  const theme = {
    ...plainTheme,
    bold: (s: string) => `<bold>${s}</bold>`,
    fg: (role: string, s: string) => `<${role}>${s}</${role}>`,
  };
  const text = rendered(h, end, false, 200, theme).join("\n");
  // Preserve native codemode's semantic success/error glyph exception before the scan anchor.
  expect(text).toContain("<success>✓</success> <bold>exec_command</bold><accent> printf first");
  expect(text).toContain(
    "<error>✗</error> <bold>exec_command</bold><accent> printf failed; exit 7",
  );
  expect(text).toContain("<dim>first</dim>");
  expect(text).toContain("<dim>failed</dim>");
  expect(text).toContain("<dim>(no output)</dim>");
  expect(text).not.toContain("input tokens");
  expect(text).not.toContain("Output");
  const tool = h.session.getToolDefinition("codemode")!;
  const call = tool.renderCall!(
    { code },
    plainTheme as never,
    { state: {}, expanded: true } as never,
  )
    .render(200)
    .join("\n");
  expect(stripVTControlCharacters(call)).toContain(code);
  expect(end.result.details.display.calls.map((c: any) => c.id)).toEqual(
    h.events
      .filter((e) => e.type === "tool_execution_start" && e.parentToolCallId === end.toolCallId)
      .map((e) => e.toolCallId),
  );
});

test("saved patch previews survive later file changes and explicit text/return values remain separate", async () => {
  initTheme("dark");
  const h = await setup();
  writeFileSync(join(h.cwd, "example.txt"), "before\n");
  const patch = "*** Begin Patch\n*** Update File: example.txt\n@@\n-before\n+after\n*** End Patch";
  const end = await h.run(
    `await tools.apply_patch(${JSON.stringify(patch)}); text('summary'); return {answer:42};`,
  );
  writeFileSync(join(h.cwd, "example.txt"), "different file contents\n");
  for (const expanded of [false, true]) {
    const text = stripVTControlCharacters(rendered(h, end, expanded).join("\n"));
    expect(text).toContain("✓ apply_patch");
    expect(text).toContain("Edit example.txt (+1 -1)");
    expect(text).toContain("-1 before");
    expect(text).toContain("+1 after");
    expect(text).not.toContain("different file contents");
    expect(text).toMatch(/Output ~\d+ input tokens/);
    expect(text).toContain('summary\n{"answer":42}');
  }
  expect(rendered(h, end, true).join("\n")).toContain("\u001b[");
  expect(textOf(end)).not.toContain("-before");
  expect(end.result.details.calls).toHaveLength(1);
  expect(
    h.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "apply_patch"),
  ).toHaveLength(1);
});

test("live shell partials show up before native completion and parallel identical tools stay distinct", async () => {
  const h = await setup();
  const pending = h.run(
    `await Promise.all([tools.exec_command({cmd:'printf early; sleep 1; printf late',login:false,yield_time_ms:30000}),tools.exec_command({cmd:'printf other',login:false})]);`,
  );
  await expect
    .poll(() =>
      h.events.some(
        (e) =>
          e.type === "tool_execution_update" &&
          e.toolName === "codemode" &&
          rendered(h, e).join("\n").includes("\nearly"),
      ),
    )
    .toBe(true);
  const partial = h.events.find(
    (e) =>
      e.type === "tool_execution_update" &&
      e.toolName === "codemode" &&
      rendered(h, e).join("\n").includes("\nearly"),
  );
  expect(partial.partialResult.content).toEqual([]);
  const end = await pending;
  const text = rendered(h, end).join("\n");
  expect(text.match(/✓ exec_command/g)).toHaveLength(2);
  expect(text).toContain("earlylate");
  expect(text).toContain("\nother");
  expect(partial.partialResult.details.display.calls.some((c: any) => c.status === "running")).toBe(
    true,
  );
});

test("hybrid snapshots are bounded and output collapse, errors, terminal controls and widths remain safe", async () => {
  initTheme("dark");
  const h = await setup();
  const end = await h.run(
    `await tools.exec_command({cmd:"printf '\\033]52;c;INJECTED\\007'; printf '界%.0s' {1..20000}",login:false}); text(Array.from({length:12},(_,i)=>'summary '+i).join('\\n')); throw new Error('visible failure');`,
  );
  expect(JSON.stringify(end.result.details.display).length).toBeLessThan(50000);
  expect(JSON.stringify(end.result.details.display)).toContain("[Display truncated]");
  for (const width of [1, 7, 20, 80])
    for (const expanded of [false, true]) {
      const lines = rendered(h, end, expanded, width);
      expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("INJECTED");
    }
  const collapsed = stripVTControlCharacters(rendered(h, end).join("\n"));
  expect(collapsed).toContain("visible failure");
  expect(collapsed).toContain("to expand");
  expect(collapsed.trimEnd().split("\n").at(-1)).toContain("to expand");
  expect(stripVTControlCharacters(rendered(h, end, true).join("\n"))).toContain("visible failure");
});

test("display retention evicts old calls without losing native metadata or storing unrelated tool results", async () => {
  const h = await setup(["read", "codemode"]);
  writeFileSync(join(h.cwd, "item.txt"), "unrelated bulk result\n");
  const end = await h.run(`for(let i=0;i<140;i++) await tools.read({path:'item.txt'});`);
  expect(end.isError, textOf(end)).toBe(false);
  expect(end.result.details.calls).toHaveLength(140);
  expect(end.result.details.display.calls).toHaveLength(128);
  expect(end.result.details.display.omitted).toBe(12);
  expect(JSON.stringify(end.result.details.display)).not.toContain("unrelated bulk result");
  const collapsed = rendered(h, end).join("\n");
  expect(collapsed.match(/✓ read/g)).toHaveLength(8);
  expect(collapsed).toContain("earlier display snapshots omitted");
  expect(collapsed.trimEnd().split("\n").at(-1)).toContain("to expand");
  expect(
    rendered(h, end, true)
      .join("\n")
      .match(/✓ read/g),
  ).toHaveLength(128);
});

test("invalid arguments and partial patch failures retain useful error rows without extra execution", async () => {
  const h = await setup();
  const invalid = await h.run(`await tools.exec_command({cmd:'true',yield_time_ms:-1});`);
  expect(rendered(h, invalid).join("\n")).toContain("✗ exec_command");
  expect(invalid.result.details.display.calls).toHaveLength(1);
  const patch =
    "*** Begin Patch\n*** Add File: applied.txt\n+retained\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch";
  const failure = await h.run(`await tools.apply_patch(${JSON.stringify(patch)});`);
  const text = stripVTControlCharacters(rendered(h, failure).join("\n"));
  expect(text).toContain("✗ apply_patch");
  expect(text).toContain("partially failed");
  expect(text).toContain("applied.txt");
  expect(text).toContain("retained");
  expect(text).toContain("missing.txt");
  expect(readFileSync(join(h.cwd, "applied.txt"), "utf8")).toBe("retained\n");
});

test("presentation scopes ignore late callbacks and throwing stale getters after reset", async () => {
  const h = await setup();
  const handlers = new Map<string, (event: any) => any>();
  const rendering = createNativeRendering(
    {
      on: (name: string, fn: (event: any) => any) => handlers.set(name, fn),
    } as unknown as ExtensionAPI,
    {},
  );
  const done = Promise.withResolvers<void>();
  const source = h.session.getToolDefinition("codemode")!;
  const original = vi.fn<typeof source.execute>(async (_id, _args, _signal, update) => {
    await done.promise;
    update?.({ content: [], details: { calls: [] } });
    return { content: [{ type: "text", text: "done" }], details: { calls: [] } };
  });
  const tool = rendering.decorate({ ...source, execute: original });
  let stale = false;
  const ctx = Object.defineProperty({}, "cwd", {
    get() {
      if (stale) throw new Error("stale getter");
      return "/old";
    },
  }) as Parameters<typeof source.execute>[4];
  const publish = vi.fn();
  const signal = new AbortController().signal;
  const pending = tool.execute("old", { code: "" }, signal, publish, ctx);
  handlers.get("tool_execution_start")!({
    parentToolCallId: "old",
    toolCallId: "child",
    toolName: "read",
    args: { path: "old.txt" },
  });
  expect(publish).toHaveBeenCalledTimes(1);
  rendering.reset();
  stale = true;
  expect(() => ctx.cwd).toThrow("stale getter");
  handlers.get("tool_execution_end")!({
    parentToolCallId: "old",
    toolCallId: "child",
    toolName: "read",
    result: { content: [], details: {} },
    isError: false,
  });
  done.resolve();
  await pending;
  expect(publish).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledWith("old", { code: "" }, signal, expect.any(Function), ctx);
  expect(
    handlers.get("tool_result")!({
      toolName: "codemode",
      toolCallId: "old",
      content: [],
      details: {},
    }),
  ).toBeUndefined();

  const next = await tool.execute("new", { code: "" }, signal, publish, {
    cwd: "/new",
  } as Parameters<typeof source.execute>[4]);
  const attached = handlers.get("tool_result")!({
    toolName: "codemode",
    toolCallId: "new",
    ...next,
  });
  expect(attached.details.display).toEqual({ cwd: "/new", calls: [], omitted: 0 });
});

test("hybrid redraws keep native output/error caches separate across partial, final, expansion and legacy fallback", async () => {
  initTheme("dark");
  const h = await setup();
  const end = await h.run(
    `await tools.exec_command({cmd:'printf nested',login:false}); text('unique explicit summary'); throw new Error('native failure');`,
  );
  const partial = h.events.find(
    (e) =>
      e.type === "tool_execution_update" &&
      e.toolName === "codemode" &&
      e.partialResult.details.display.calls.length,
  );
  const tool = h.session.getToolDefinition("codemode")!;
  let previous: Component | undefined;
  const state = {};
  const draw = (result: any, isPartial = false, expanded = false) => {
    const component = tool.renderResult!(result, { isPartial, expanded }, plainTheme as never, {
      args: { code: "" },
      toolCallId: end.toolCallId,
      state,
      lastComponent: previous,
      cwd: h.cwd,
      executionStarted: true,
      argsComplete: true,
      invalidate() {},
      isPartial,
      isError: end.isError,
      expanded,
      showImages: false,
    });
    previous = component;
    return stripVTControlCharacters(component.render(100).join("\n"));
  };
  expect(draw(partial.partialResult, true)).toContain("exec_command");
  for (const expanded of [false, true, false]) {
    const text = draw(end.result, false, expanded);
    expect(text).toContain("unique explicit summary");
    expect(text).toContain("native failure");
    expect(text.match(/Script error:/g)).toHaveLength(1);
  }
  // A previous native Text must not be shared between the two delegated renderers.
  previous = new Text("previous native output", 0, 0);
  const text = draw(end.result);
  expect(text).toContain("unique explicit summary");
  expect(text.match(/Script error:/g)).toHaveLength(1);
  const { display: _display, ...legacyDetails } = end.result.details;
  expect(draw({ ...end.result, details: legacyDetails })).toContain("unique explicit summary");
});

test("hybrid caches idle redraws but rerenders on resize and invalidation", async () => {
  const h = await setup();
  const child = {
    render: vi.fn(() => ["nested preview"]),
    invalidate: vi.fn(),
  };
  const output = {
    render: vi.fn(() => ["script output"]),
    invalidate: vi.fn(),
  };
  const rendering = createNativeRendering({ on() {} } as unknown as ExtensionAPI, {
    web_run: { renderCall: () => child },
  });
  const tool = rendering.decorate({
    ...h.session.getToolDefinition("codemode")!,
    renderResult: () => output,
  });
  const component = tool.renderResult!(
    {
      content: [{ type: "text", text: "script output" }],
      details: {
        display: {
          cwd: h.cwd,
          omitted: 0,
          calls: [{ id: "child", name: "web_run", args: {}, status: "completed", startedAt: 0 }],
        },
      },
    },
    { expanded: false, isPartial: false },
    plainTheme as never,
    {
      args: { code: "" },
      toolCallId: "restored",
      state: {},
      lastComponent: undefined,
      invalidate() {},
      cwd: h.cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      isError: false,
      expanded: false,
      showImages: false,
    },
  );
  const first = component.render(80);
  expect(component.render(80)).toBe(first);
  expect(child.render).toHaveBeenCalledTimes(1);
  expect(output.render).toHaveBeenCalledTimes(1);

  const narrow = component.render(7);
  expect(narrow.every((line) => visibleWidth(line) <= 7)).toBe(true);
  expect(child.render).toHaveBeenCalledTimes(2);
  expect(output.render).toHaveBeenCalledTimes(2);

  component.invalidate();
  expect(child.invalidate).toHaveBeenCalledTimes(1);
  expect(output.invalidate).toHaveBeenCalledTimes(1);
  expect(component.render(7)).toEqual(narrow);
  expect(child.render).toHaveBeenCalledTimes(3);
  expect(output.render).toHaveBeenCalledTimes(3);
});

test.each(["custom", "constructor", "toString", "__proto__"])(
  "unrelated %s errors retain only text, never arbitrary details or image payloads",
  async (name) => {
    const h = await setup();
    const handlers = new Map<string, (event: any) => any>();
    const rendering = createNativeRendering(
      {
        on: (name: string, fn: (event: any) => any) => handlers.set(name, fn),
      } as unknown as ExtensionAPI,
      {},
    );
    const source = h.session.getToolDefinition("codemode")!;
    const done = Promise.withResolvers<Awaited<ReturnType<typeof source.execute>>>();
    const tool = rendering.decorate({ ...source, execute: () => done.promise });
    const pending = tool.execute(
      "boundary",
      { code: "" },
      new AbortController().signal,
      undefined,
      {
        cwd: h.cwd,
      } as Parameters<typeof source.execute>[4],
    );
    handlers.get("tool_execution_start")!({
      parentToolCallId: "boundary",
      toolCallId: "custom-error",
      toolName: name,
      args: {},
    });
    handlers.get("tool_execution_end")!({
      parentToolCallId: "boundary",
      toolCallId: "custom-error",
      toolName: name,
      isError: true,
      result: {
        content: [
          { type: "text", text: "Useful custom failure" },
          { type: "image", mimeType: "image/png", data: "private-image-payload" },
        ],
        details: { privateToken: "private-token-value", image: { data: "nested-image-payload" } },
        structuredContent: { privateStructuredValue: "private-structured-value" },
      },
    });
    const parentResult = {
      content: [{ type: "text" as const, text: "unchanged model output" }],
      details: { calls: [] },
    };
    done.resolve(parentResult);
    expect(await pending).toBe(parentResult);
    const attached = handlers.get("tool_result")!({
      toolName: "codemode",
      toolCallId: "boundary",
      ...parentResult,
    });
    const snapshot = attached.details.display.calls[0].result;
    expect(snapshot.content).toEqual([{ type: "text", text: "Useful custom failure" }]);
    expect(snapshot.details).toBeUndefined();
    expect(JSON.stringify(attached.details.display)).not.toMatch(
      /private-token-value|private-image-payload|nested-image-payload|private-structured-value/,
    );
  },
);
