import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import {
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
        durationMs: undefined,
        outputPad: 1,
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
  context: Record<string, unknown> = {},
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
      durationMs: undefined,
      outputPad: 1,
      ...context,
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
    expect(text).toContain("summary");
    expect(text).toContain('{"answer":42}');
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
      durationMs: undefined,
      outputPad: 1,
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
    renderResult: (result) => (result.content.length ? output : new Text("", 0, 0)),
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
      durationMs: undefined,
      outputPad: 1,
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

test("nested snapshots prefer recorded duration and delegate only their own timing, including legacy absence", async () => {
  const h = await setup();
  const handlers = new Map<string, (event: any) => any>();
  const childContexts: any[] = [];
  const rendering = createNativeRendering(
    {
      on: (name: string, fn: (event: any) => any) => handlers.set(name, fn),
    } as unknown as ExtensionAPI,
    {
      web_run: {
        renderCall: (_args, _theme, ctx) => {
          childContexts.push(ctx);
          return new Text("child", 0, 0);
        },
      },
    },
  );
  const tool = rendering.decorate({
    ...h.session.getToolDefinition("codemode")!,
    execute: async () => ({ content: [], details: { calls: [] } }),
  });
  await tool.execute("parent", { code: "" }, new AbortController().signal, undefined, {
    cwd: h.cwd,
  } as never);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (const [id, durationMs] of [
      ["recorded", 123],
      ["fallback", undefined],
    ] as const) {
      clock.mockReturnValue(1000);
      handlers.get("tool_execution_start")!({
        parentToolCallId: "parent",
        toolCallId: id,
        toolName: "web_run",
        args: {},
      });
      clock.mockReturnValue(9000);
      handlers.get("tool_execution_end")!({
        parentToolCallId: "parent",
        toolCallId: id,
        toolName: "web_run",
        durationMs,
        isError: false,
        result: { content: [] },
      });
    }
    const result = {
      content: [],
      ...handlers.get("tool_result")!({
        toolName: "codemode",
        toolCallId: "parent",
        content: [],
        details: { calls: [] },
      }),
    };
    expect(result.details.display.calls.map((call: any) => call.durationMs)).toEqual([123, 8000]);
    // Round-trip saved display; old snapshots have no duration and must not inherit the script's.
    const saved = JSON.parse(JSON.stringify(result));
    delete saved.details.display.calls[1].durationMs;
    const component = tool.renderResult!(
      saved,
      { expanded: false, isPartial: false },
      plainTheme as never,
      {
        durationMs: 9876,
        state: {},
        expanded: false,
        outputPad: 1,
      } as never,
    );
    expect(component.render(100).join("\n")).toContain("123ms");
    expect(childContexts.map((ctx) => ctx.durationMs)).toEqual([123, undefined]);
  } finally {
    clock.mockRestore();
  }
});

test("one native overall timer survives silent, clipped and expanded output, with the hint last", async () => {
  const h = await setup(["read", "codemode"]);
  writeFileSync(join(h.cwd, "item.txt"), "nested output");
  for (const code of [
    "void 0;",
    "text('script only');",
    "await tools.read({path:'item.txt'});",
    "await tools.read({path:'item.txt'}); text('short');",
    "await tools.read({path:'item.txt'}); text(Array.from({length:20},(_,i)=>'line '+i).join('\\n'));",
    "await tools.read({path:'item.txt'}); text(Array.from({length:20},(_,i)=>'line '+i).join('\\n')); throw new Error('failure');",
  ]) {
    const end = await h.run(code);
    expect(end.isError).toBe(code.includes("failure"));
    for (const expanded of [false, true]) {
      const lines = rendered(h, end, expanded, 100, plainTheme, { durationMs: 4321, outputPad: 3 });
      const text = lines.join("\n");
      expect(text.match(/Took /g)).toHaveLength(1);
      expect(text).toContain("Took 4.3s");
      const timerLine = lines.indexOf("Took 4.3s");
      expect(lines[timerLine - 1]).toBe("");
      expect(lines[timerLine - 2]).not.toBe("");
      if (code.includes("failure")) {
        expect(text).toContain("failure");
        if (!expanded) expect(lines.at(-1)).toContain("to expand");
      }
      // The default host shell owns horizontal padding, even for nondefault outputPad.
      expect(lines.find((line) => line.includes("Took "))).toBe("Took 4.3s");
    }
    expect(rendered(h, end).join("\n")).not.toMatch(/Took |Elapsed /);
  }
});

test("silent running scripts reuse native live timing and finish with recorded time", async () => {
  const h = await setup(["read", "codemode"]);
  writeFileSync(join(h.cwd, "item.txt"), "nested output");
  const end = await h.run("await tools.read({path:'item.txt'});");
  const tool = h.session.getToolDefinition("codemode")!;
  const state = {};
  const invalidate = vi.fn();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1000);
    tool.renderCall!({ code: "" }, plainTheme as never, { state, executionStarted: true } as never);
    const partial = { type: "tool_execution_update", partialResult: end.result };
    const context = { state, invalidate };
    expect(rendered(h, partial, false, 100, plainTheme, context).join("\n")).toContain(
      "Elapsed 0.0s",
    );
    vi.advanceTimersByTime(2000);
    expect(invalidate).toHaveBeenCalled();
    expect(rendered(h, partial, false, 100, plainTheme, context).join("\n")).toContain(
      "Elapsed 2.0s",
    );
    expect(
      rendered(h, end, false, 100, plainTheme, { ...context, durationMs: 321 }).join("\n"),
    ).toContain("Took 0.3s");
    const invalidations = invalidate.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(invalidate).toHaveBeenCalledTimes(invalidations);
  } finally {
    vi.useRealTimers();
  }
});

test("the host applies configured output padding once around code, nested rows, output and timing", async () => {
  initTheme("dark");
  const h = await setup(["read", "codemode"]);
  writeFileSync(join(h.cwd, "item.txt"), "nested output");
  const code = "await tools.read({path:'item.txt'}); text('explicit summary');";
  const end = await h.run(code);
  const tool = h.session.getToolDefinition("codemode")!;
  for (const expanded of [false, true]) {
    const row = new ToolExecutionComponent(
      "codemode",
      end.toolCallId,
      { code },
      { outputPad: 3, showImages: false },
      tool,
      { requestRender() {} } as never,
      h.cwd,
    );
    row.setArgsComplete();
    row.setExpanded(expanded);
    row.updateResult({ ...end.result, isError: false, durationMs: 4321 });
    const lines = row.render(100).map(stripVTControlCharacters);
    for (const fragment of ["await tools.read", "✓ read", "explicit summary", "Took 4.3s"]) {
      const line = lines.find((line) => line.includes(fragment));
      expect(line).toBeDefined();
      expect(line).toMatch(/^ {3}\S/);
    }
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
    expect(lines[0]?.trim()).toBe("");
    expect(lines.at(-1)?.trim()).toBe("");
  }
});

test("nested web rows share the host inset in live and saved collapsed and expanded results", async () => {
  initTheme("dark");
  const h = await setup(undefined, {
    config: { codexAdapter: { webSearchProviders: ["native-test"] } },
  });
  const helper = join(h.cwd, "web-helper");
  const output = { output_text: "first\nlast 界\u001b]52;c;INJECTED\u0007" };
  writeFileSync(helper, `#!/bin/sh\nprintf '%s' '${JSON.stringify(output)}'\n`, { mode: 0o755 });
  vi.stubEnv("PI_CODEX_WEB_RUN_BIN", helper);
  try {
    const code = `await tools.web_run({search_query:[{q:'docs'}],open:[{ref_id:'turn0view0'}]});`;
    const success = await h.run(code);
    expect(success.isError, textOf(success)).toBe(false);
    writeFileSync(helper, "#!/bin/sh\nprintf 'search unavailable' >&2\nexit 1\n");
    const failure = await h.run(code);
    expect(failure.isError).toBe(true);
    const partial = h.events.find(
      (e) =>
        e.type === "tool_execution_update" &&
        e.toolName === "codemode" &&
        e.partialResult.details.display.calls.some((call: any) => call.name === "web_run"),
    );
    expect(partial).toBeDefined();
    // Historical inspection must use only serializable display data, not the helper.
    writeFileSync(helper, "#!/bin/sh\nexit 99\n");
    const saved = JSON.parse(JSON.stringify(success));
    for (const event of [partial, success, failure, saved]) {
      for (const outputPad of [0, 1]) {
        for (const expanded of [false, true]) {
          for (const width of [1, 2, 7, 80])
            expect(
              rendered(h, event, expanded, width, plainTheme, { outputPad }).every(
                (line) => visibleWidth(line) <= width,
              ),
            ).toBe(true);
          const row = new ToolExecutionComponent(
            "codemode",
            success.toolCallId,
            { code },
            { outputPad, showImages: false },
            h.session.getToolDefinition("codemode")!,
            { requestRender() {} } as never,
            h.cwd,
          );
          row.setArgsComplete();
          row.setExpanded(expanded);
          row.updateResult(
            {
              ...(event.result ?? event.partialResult),
              isError: event.isError ?? false,
            },
            event === partial,
          );
          for (const width of [7, 80]) {
            const lines = row.render(width).map(stripVTControlCharacters);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(lines.join("\n")).not.toContain("INJECTED");
            if (width !== 80) continue;
            const summary = lines.find((line) => line.includes("Web Search"));
            expect(summary?.trimEnd()).toBe(
              outputPad === 0 ? "Web Search docs · Open page" : " Web Search docs · Open page",
            );
            const index = lines.indexOf(summary!);
            expect(lines[index - 1]?.trim()).toBe("");
            expect(lines[index + 1]?.trim()).toBe("");
            expect(lines.filter((line) => line.includes("Web Search"))).toHaveLength(1);
            if (expanded && (event === success || event === saved))
              expect(
                lines.some((line) => line.trimEnd() === (outputPad ? " last 界" : "last 界")),
              ).toBe(true);
            if (event === failure) expect(lines.join("\n")).toContain("search unavailable");
          }
        }
      }
    }
    expect(
      rendered(h, saved, true, 200, {
        ...plainTheme,
        bold: (s) => `<bold>${s}</bold>`,
        fg: (role, s) => `<${role}>${s}</${role}>`,
      }).join("\n"),
    ).toContain("<bold>Web</bold><accent> Search docs · Open page</accent>");
    expect(
      h.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "web_run"),
    ).toHaveLength(2);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("truncated native output remains retrievable with final timing outside the collapsed preview", async () => {
  const h = await setup(["read", "codemode"]);
  writeFileSync(join(h.cwd, "item.txt"), "nested output");
  const end = await h.run(
    '// @options: {"max_output_tokens": 100}\nawait tools.read({path:"item.txt"}); text("retained full output\\n".repeat(1000));',
  );
  const path = end.result.details.fullOutputPath;
  expect(path).toBeTypeOf("string");
  expect(readFileSync(path, "utf8")).toContain("retained full output");
  for (const expanded of [false, true]) {
    const text = rendered(h, end, expanded, 200, plainTheme, { durationMs: 4321 }).join("\n");
    expect(text).toContain(path);
    expect(text.match(/Took /g)).toHaveLength(1);
    expect(text).toContain("Took 4.3s");
    for (const width of [1, 7, 20])
      expect(
        rendered(h, end, expanded, width, plainTheme, { durationMs: 4321 }).every(
          (line) => visibleWidth(line) <= width,
        ),
      ).toBe(true);
  }
});

test("nested-only shell, error, web and patch previews keep an expansion hint below overall timing", async () => {
  initTheme("dark");
  const h = await setup();
  const shell = await h.run(
    `await tools.exec_command({cmd:"printf '%s\\n' {1..20}",login:false});`,
  );
  const patch =
    "*** Begin Patch\n*** Add File: long-preview.txt\n" +
    Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n") +
    "\n*** End Patch";
  const patched = await h.run(`await tools.apply_patch(${JSON.stringify(patch)});`);
  const restored = (name: string) => ({
    result: {
      content: [],
      details: {
        calls: [],
        display: {
          cwd: h.cwd,
          omitted: 0,
          calls: [
            {
              id: "saved-child",
              name,
              args: {},
              status: name === "custom" ? "error" : "completed",
              startedAt: 0,
              result: {
                content: [
                  {
                    type: "text",
                    text: Array.from({ length: 20 }, (_, i) => `detail ${i}`).join("\n"),
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });
  for (const end of [shell, patched, restored("custom"), restored("web_run")]) {
    for (const expanded of [false, true]) {
      const lines = rendered(h, end, expanded, 200, plainTheme, { durationMs: 4321 });
      expect(lines.join("\n")).toContain("Took 4.3s");
      expect(lines.at(-1)).toContain(expanded ? "Took 4.3s" : "to expand");
    }
  }
  expect(
    rendered(h, shell, false, 200, plainTheme, { durationMs: 4321 }).join("\n").match(/Took /g),
  ).toHaveLength(2); // Shell per-wait timing remains separate from overall script timing.
  const styled = rendered(
    h,
    shell,
    false,
    200,
    {
      ...plainTheme,
      fg: (role, text) => `<${role}>${text}</${role}>`,
    },
    { durationMs: 4321 },
  );
  expect(stripVTControlCharacters(styled.at(-1) ?? "")).toMatch(/^<dim>\(.*to expand\)<\/dim>$/);

  // A child hidden by wrapping may become fully visible after resize.
  const saved = JSON.parse(JSON.stringify(shell.result));
  saved.details.display.calls[0].result.details.output = "x".repeat(600);
  const component = h.session.getToolDefinition("codemode")!.renderResult!(
    saved,
    { expanded: false, isPartial: false },
    plainTheme as never,
    { durationMs: 4321, state: {}, expanded: false } as never,
  );
  expect(component.render(80).at(-1)).toContain("to expand");
  expect(component.render(800).at(-1)?.trimEnd()).toBe("Took 4.3s");
});
