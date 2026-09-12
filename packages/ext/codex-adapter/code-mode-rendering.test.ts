import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerCodeMode from "./code-mode/registration.js";
import { codeModeResult } from "./code-mode/results.js";
import { NestedTraces, type NestedTrace } from "./code-mode/nested-traces.js";

const plain = {
  bold: (text: string) => text,
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
};
const styled = {
  bold: (text: string) => `<bold>${text}</bold>`,
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bg: (_role: string, text: string) => text,
};
function setup() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  registerCodeMode(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerMarkdownTransformer() {},
      on(name: string, handler: any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getActiveTools: () => [],
      setActiveTools() {},
    } as never,
    { current: {} },
  );
  function row(name: "exec" | "wait", id: string, expanded = false, theme = plain) {
    const tool = tools.get(name);
    const context = {
      toolCallId: id,
      args: name === "exec" ? { code: 'const secretJavaScript = "hidden";' } : { cell_id: "cell" },
      state: {},
      cwd: "/tmp",
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      isError: false,
      expanded,
      showImages: true,
      invalidate: vi.fn(),
      lastComponent: undefined,
    };
    let call = tool.renderCall(context.args, theme, context);
    let body: any;
    return {
      context,
      update(result: any, partial = false) {
        context.isPartial = partial;
        context.isError = !!result.details?.failed;
        body = tool.renderResult(
          result,
          { expanded: context.expanded, isPartial: partial },
          theme,
          context,
        );
        call = tool.renderCall(context.args, theme, context);
      },
      lines(width = 100) {
        return [...call.render(width), ...(body?.render(width) ?? [])];
      },
      text(width = 100) {
        return this.lines(width)
          .map((line: string) => line.trimEnd())
          .join("\n");
      },
    };
  }
  return {
    row,
    tools,
    async emit(name: string) {
      const ctx = {
        cwd: "/tmp",
        model: undefined,
        sessionManager: { getSessionId: () => "restored" },
        ui: { notify() {} },
      };
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
  };
}
function command(
  id: string,
  state: NestedTrace["state"] = "completed",
  output = "hello",
): NestedTrace {
  return {
    cellId: "cell",
    callId: id,
    name: "exec_command",
    input: { cmd: `printf ${id}` },
    state,
    ...(state === "approval"
      ? {}
      : {
          result: {
            content: [{ type: "text" as const, text: output }],
            details: { output, wall_time_seconds: 1.5, exit_code: state === "error" ? 7 : 0 },
          },
        }),
  };
}
function snapshot(
  traces: NestedTrace[],
  version = 1,
  state: "result" | "yielded" = "result",
  text?: string,
  errorText?: string,
) {
  return codeModeResult(
    {
      kind: state,
      cellId: "cell",
      contentItems: text ? [{ type: "input_text", text }] : [],
      errorText,
    },
    1500,
    10000,
    traces,
    version,
  );
}

test("registered exec/wait transfer nested display ownership on restore, independent of redraw order", () => {
  const h = setup();
  const exec = h.row("exec", "outer-1");
  expect(exec.text()).toBe("\nexec executing\n");
  exec.update(JSON.parse(JSON.stringify(snapshot([command("first", "running")], 1, "yielded"))));
  expect(exec.text()).toContain("Exec printf first");
  const wait = h.row("wait", "outer-2");
  const final = JSON.parse(JSON.stringify(snapshot([command("first"), command("second")], 2)));
  wait.update(final);
  expect(wait.text().match(/Exec printf/g)).toHaveLength(2);
  expect(exec.text()).toBe("");
  expect(exec.context.invalidate).toHaveBeenCalled();
  // Replaying an earlier snapshot cannot steal ownership back from the saved final wait.
  exec.update(snapshot([command("first", "running")], 1, "yielded"));
  expect(exec.text()).toBe("");
  expect(wait.text()).not.toMatch(/secretJavaScript|cell_id|^wait /m);
});

test("a pending wait keeps the known children visible until a newer result takes ownership", () => {
  const h = setup();
  const exec = h.row("exec", "outer-1");
  exec.update(snapshot([command("first")], 1, "yielded"));
  const wait = h.row("wait", "outer-2");
  wait.update(snapshot([command("first")], 2, "yielded"), true);
  expect(exec.text()).toBe("");
  expect(wait.text()).toContain("Exec printf first");
});

test("streamed calls retain invocation order, independent approval state, styles, and one set of padding", () => {
  const h = setup();
  const row = h.row("exec", "outer", false, styled);
  row.update(snapshot([command("one", "approval"), command("two", "completed")]), true);
  const lines = row.lines(200).map((line: string) => line.trimEnd());
  expect(lines[0]).toBe("");
  expect(lines.at(-1)).toBe("");
  expect(lines[1]).toBe("<bold>Exec</bold><accent> printf one</accent>");
  expect(row.text(200)).toContain("<dim>Awaiting approval</dim>");
  row.update(snapshot([command("one", "error", "denied"), command("two")]));
  const text = row.text(200);
  expect(text.indexOf("printf one")).toBeLessThan(text.indexOf("printf two"));
  expect(text.match(/denied/g)).toHaveLength(1);
  expect(text).not.toContain("Awaiting approval");
});

test("standalone output and independent script errors remain visible without exposing source", () => {
  const h = setup();
  const row = h.row("exec", "outer");
  row.update(snapshot([], 1, "result", "42"));
  expect(row.text()).toBe("\nexec completed\n\n42\n");
  row.update(snapshot([command("success")], 1, "result", undefined, "Error: script exploded"));
  expect(row.text()).toContain("Error: script exploded");
  expect(row.text()).not.toContain("secretJavaScript");
});

test("a failed outer execution without Code Mode details still shows its error", () => {
  const row = setup().row("exec", "outer");
  row.update({ content: [{ type: "text", text: "host unavailable" }], details: undefined });
  row.context.isError = true;
  expect(row.text()).toContain("host unavailable");
});

test("standalone explicit output survives script failure", () => {
  const row = setup().row("exec", "outer");
  row.update(snapshot([], 1, "result", "before failure", "Error: exploded"));
  expect(row.text()).toContain("before failure");
  expect(row.text().match(/exploded/g)).toHaveLength(1);
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("restored patches, web calls, shell input and images reuse their ordinary renderers", () => {
  const h = setup();
  const row = h.row("exec", "outer", false, styled);
  const traces: NestedTrace[] = [
    {
      cellId: "cell",
      callId: "patch",
      name: "apply_patch",
      state: "completed",
      input: {
        input: "*** Begin Patch\n*** Add File: missing-restore-file.txt\n+new\n*** End Patch",
      },
      result: {
        content: [],
        details: {
          render: {
            status: "pending",
            collapsedDiff: "Add missing-restore-file.txt (+1 -0)\n\n\u001b[32m+new\u001b[39m",
            expanded: "Add missing-restore-file.txt (+1 -0)\n\nexpanded diff",
          },
        },
      },
    },
    {
      cellId: "cell",
      callId: "web",
      name: "web_run",
      state: "completed",
      input: { search_query: [{ q: "pi docs" }] },
      result: { content: [{ type: "text", text: "web result body" }], details: {} },
    },
    {
      cellId: "cell",
      callId: "input",
      name: "write_stdin",
      state: "completed",
      input: { session_id: 17, chars: "yes\n" },
      result: command("input").result,
    },
    {
      cellId: "cell",
      callId: "image",
      name: "view_image",
      state: "completed",
      input: { path: "picture.png" },
      result: {
        content: [{ type: "image", data: png, mimeType: "image/png" }],
        details: { path: "picture.png" },
      },
    },
  ];
  row.update(JSON.parse(JSON.stringify(snapshot(traces))));
  const collapsed = row.text(250);
  expect(collapsed).toContain("<bold>Add</bold><accent> missing-restore-file.txt (+1 -0)</accent>");
  expect(collapsed).toContain("\u001b[32m+new\u001b[39m");
  expect(collapsed).toContain("<bold>Web</bold>");
  expect(collapsed).toContain("pi docs");
  expect(collapsed).not.toContain("web result body");
  expect(collapsed).toContain("to expand");
  expect(collapsed).toContain("<bold>Input</bold><accent> session 17</accent>");
  expect(collapsed).toContain("<bold>View</bold><accent> picture.png</accent>");
  expect(collapsed).toContain("image/png");
  expect(collapsed).not.toContain(png);
  row.context.expanded = true;
  row.update(snapshot(traces));
  expect(row.text(250)).toContain("expanded diff");
  expect(row.text(250).match(/web result body/g)).toHaveLength(1);
});

test("an emitted image is left to Pi's outer image renderer and never drawn twice", () => {
  const row = setup().row("exec", "outer");
  const image = { type: "image" as const, data: png, mimeType: "image/png" };
  const result = snapshot([
    {
      cellId: "cell",
      callId: "image",
      name: "view_image",
      state: "completed",
      input: { path: "picture.png" },
      result: { content: [image], details: {} },
    },
  ]);
  result.content.push(image);
  row.update(result);
  expect(row.text()).toContain("View picture.png");
  expect(row.text()).not.toContain("image/png");
  expect(result.content.filter((item) => item.type === "image")).toEqual([image]);
});

test.each([1, 7, 20, 80])(
  "collapsed and expanded restored results fit a %i-column terminal",
  (width) => {
    const h = setup();
    const row = h.row("exec", "outer");
    const result = snapshot([
      command(
        "界".repeat(80),
        "completed",
        "\u001b]52;c;INJECTED\u0007" +
          Array.from({ length: 30 }, (_, i) => `line ${i} ${"界".repeat(25)}`).join("\n"),
      ),
    ]);
    for (const expanded of [false, true]) {
      row.context.expanded = expanded;
      row.update(result);
      expect(row.lines(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
      expect(row.text(width)).not.toContain("INJECTED");
      expect(row.text(width)).not.toContain("\u001b]52");
      expect(row.lines(width)[0]?.trim()).toBe("");
      expect(row.lines(width).at(-1)?.trim()).toBe("");
    }
  },
);

test("trace observers see bounded snapshots in invocation order without changing model values", () => {
  const traces = new NestedTraces();
  const updates: NestedTrace[][] = [];
  const observer = traces.observe("cell", () => updates.push(traces.forCell("cell")));
  const first = command("one", "approval");
  traces.record(first);
  traces.record(command("two"));
  traces.record(command("one", "error", "denied"));
  expect(updates.at(-1)?.map((trace) => [trace.callId, trace.state])).toEqual([
    ["one", "error"],
    ["two", "completed"],
  ]);
  const full = "long output".repeat(100000);
  traces.record(command("huge", "completed", full));
  expect(JSON.stringify(traces.forCell("cell")).length).toBeLessThan(100000);
  const result = codeModeResult(
    {
      kind: "result",
      cellId: "cell",
      contentItems: [{ type: "input_text", text: "only deliberate output" }],
    },
    0,
    10000,
    traces.forCell("cell"),
  );
  expect(result.content).toHaveLength(2);
  expect(result.content[1]).toEqual({ type: "text", text: "only deliberate output" });
  const saved = JSON.parse(JSON.stringify(result));
  observer.dispose();
  traces.clear();
  const row = setup().row("exec", "restored");
  row.update(saved);
  expect(row.text()).toContain("denied");
  expect(row.text()).toContain("Display truncated");
  expect(traces.forCell("cell")).toEqual([]);
});

test("wait ownership never hides standalone output emitted by an earlier yield", () => {
  const h = setup();
  const exec = h.row("exec", "outer-exec");
  exec.update(snapshot([], 1, "yielded", "first emitted value"));
  const wait = h.row("wait", "outer-wait");
  wait.update(snapshot([], 2, "result", "second emitted value"));
  expect(exec.text()).toContain("first emitted value");
  expect(wait.text()).toContain("second emitted value");
});

test.each(["session_start", "session_tree"])(
  "%s forgets owners from the departed transcript branch",
  async (event) => {
    const h = setup();
    const latest = h.row("wait", "old-branch");
    latest.update(snapshot([command("old")], 9));
    await h.emit(event);
    const restored = h.row("exec", "earlier-branch");
    restored.update(snapshot([command("restored")], 1));
    expect(restored.text()).toContain("Exec printf restored");
  },
);

test("script errors stay visible after long collapsed output, with the expansion hint last", () => {
  const row = setup().row("exec", "outer");
  row.update(
    snapshot(
      [],
      1,
      "result",
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
      "Script exploded",
    ),
  );
  const lines = row.lines().map((line: string) => line.trimEnd());
  expect(lines).toContain("Script exploded");
  expect(lines.at(-2)).toContain("to expand");
});

test("images emitted in a yielded exec are not repeated inside the later wait", () => {
  const h = setup();
  const trace: NestedTrace = {
    cellId: "cell",
    callId: "image",
    name: "view_image",
    state: "completed",
    input: { path: "picture.png" },
    result: { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} },
  };
  const first = snapshot([trace], 1, "yielded");
  first.content.push({ type: "image", data: png, mimeType: "image/png" });
  const exec = h.row("exec", "image-exec");
  exec.update(first);
  const wait = h.row("wait", "image-wait");
  wait.update(snapshot([trace], 2));
  expect(wait.text()).toContain("View picture.png");
  expect(wait.text()).not.toContain("image/png");
});

test("an earlier emitted image deduplicates the visible wait even when restored out of order", () => {
  const h = setup();
  const trace: NestedTrace = {
    cellId: "cell",
    callId: "image",
    name: "view_image",
    state: "completed",
    input: { path: "picture.png" },
    result: { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} },
  };
  const wait = h.row("wait", "image-wait");
  wait.update(snapshot([trace], 2));
  expect(wait.text()).toContain("image/png");
  const earlier = snapshot([trace], 1, "yielded");
  earlier.content.push({ type: "image", data: png, mimeType: "image/png" });
  const exec = h.row("exec", "image-exec");
  exec.update(earlier);
  expect(wait.text()).not.toContain("image/png");
  expect(wait.context.invalidate).toHaveBeenCalled();
  expect(exec.text()).toBe("");
});
