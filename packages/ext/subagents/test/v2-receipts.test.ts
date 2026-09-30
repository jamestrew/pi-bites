import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { saveSettings } from "../settings.js";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { harness, setupV2 } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const theme = {
  bold: (s: string) => `<b>${s}</b>`,
  fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
};
const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };

it("previews three message display lines under the spawn scanline and expands the original", () => {
  const tool = harness(cleanup).direct.get("spawn_agent");
  const args = {
    task_name: "audit_auth",
    agent_type: "explorer",
    model: "openai/gpt-5.4",
    reasoning_effort: "high",
    message: "Inspect middleware.\nCheck tests.\nReport findings.\n\nDo not edit.",
  };
  const context = { state: {}, expanded: false, isError: false };
  const lines = tool.renderCall(args, theme, context).render(120);
  expect(lines.slice(0, 5)).toEqual([
    "<b>spawn_agent</b><accent> audit_auth explorer: openai/gpt-5.4 high</accent>",
    "",
    "<dim>Inspect middleware.</dim>",
    "<dim>Check tests.</dim>",
    "<dim>Report findings.</dim>",
  ]);
  expect(lines.at(-1)).toContain("to expand");
  context.expanded = true;
  expect(tool.renderCall(args, plain, context).render(120)).toEqual([
    "spawn_agent audit_auth explorer: openai/gpt-5.4 high",
    "",
    ...args.message.split("\n"),
  ]);
});

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
function rendered(row: ToolExecutionComponent, width = 100) {
  const lines = row.render(width);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  return lines.map((line) => stripVTControlCharacters(line).trim());
}

it("redraws final spawn metadata immediately and restores the saved receipt without a live child", async () => {
  const h = await setupV2(cleanup);
  h.faux.setResponses([fauxAssistantMessage("done")]);
  const args = {
    task_name: "audit_auth",
    message: "Inspect middleware.",
    model: "test-model",
    agent_type: "explorer",
  };
  const tool = h.direct.get("spawn_agent");
  const row = host(tool, args);
  row.markExecutionStarted();
  row.setArgsComplete();
  expect(rendered(row)).toContain("spawn_agent audit_auth explorer: test-model");
  const result = await h.call("spawn_agent", args);
  expect(JSON.parse(result.content[0].text)).toEqual({ task_name: "/root/audit_auth" });
  expect(result.details).toMatchObject({
    task_name: "/root/audit_auth",
    subagentType: "explorer",
    modelName: "v2-mail/test-model",
    thinking: "off",
  });
  row.updateResult({ ...result, isError: false });
  const expected = "spawn_agent /root/audit_auth explorer: v2-mail/test-model off";
  expect(rendered(row).filter(Boolean)).toEqual([expected, "Inspect middleware."]);
  await h.manager.waitForAll();
  await h.emit("session_shutdown");
  const restored = host(tool, args);
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  for (const expanded of [false, true]) {
    restored.setExpanded(expanded);
    const lines = rendered(restored);
    expect(lines.filter(Boolean)).toEqual([expected, "Inspect middleware."]);
    // Pi supplies its leading spacer plus the default shell's vertical padding.
    expect(lines.slice(0, 2)).toEqual(["", ""]);
    expect(lines.at(-1)).toBe("");
  }
});

it.each(["spawn_agent", "send_message", "followup_task"])(
  "keeps %s failures/cancellations below the preview and the expansion hint last",
  (name) => {
    const tool = harness(cleanup).direct.get(name);
    const args = {
      task_name: "audit_auth",
      target: "audit_auth",
      message: "one\ntwo\nthree\nfour",
    };
    const context = { state: {}, expanded: false, isError: false };
    const row = tool.renderCall(args, theme, context);
    // Partial data is not an accepted spawn/message receipt.
    tool.renderResult(
      { content: [], details: { target: "/root/audit_auth", status: "queued" } },
      { isPartial: true },
      theme,
      context,
    );
    expect(row.render(100)[0]).not.toContain("queued");
    for (const error of ["No concurrency slot is available.", "Error: Tool execution aborted"]) {
      context.isError = true;
      expect(
        tool
          .renderResult(
            { content: [{ type: "text", text: error }] },
            { isPartial: false },
            theme,
            context,
          )
          .render(100),
      ).toEqual([]);
      const lines = row.render(100);
      expect(lines.slice(1, 5)).toEqual([
        "",
        "<dim>one</dim>",
        "<dim>two</dim>",
        "<dim>three</dim>",
      ]);
      expect(lines.slice(-3, -1)).toEqual([
        "",
        `<dim>${error.startsWith("Error:") ? error : `Error: ${error}`}</dim>`,
      ]);
      expect(lines.at(-1)).toContain("to expand");
      expect(lines[0]).not.toMatch(/queued|submitted|stopped/);
      const failed = host(tool, args);
      failed.updateResult({ content: [{ type: "text", text: error }], isError: true });
      failed.setExpanded(true);
      const all = rendered(failed);
      expect(all.filter(Boolean).slice(1)).toEqual([
        "one",
        "two",
        "three",
        "four",
        error.startsWith("Error:") ? error : `Error: ${error}`,
      ]);
      expect(all.slice(0, 2)).toEqual(["", ""]);
      expect(all.at(-1)).toBe("");
    }
  },
  10_000,
);

it("shows available configured spawn metadata before success without inventing unknown fields", async () => {
  const h = await setupV2(cleanup);
  saveSettings({ defaultModel: "test-model", defaultReasoningEffort: "off" }, h.ctx.cwd);
  await h.emit("session_start");
  const tool = h.direct.get("spawn_agent");
  const context = { state: {}, expanded: false };
  const args = { task_name: "a", message: "work" };
  expect(tool.renderCall(args, plain, context).render(100)[0]).toBe("spawn_agent a test-model off");
  expect(
    tool
      .renderCall({ ...args, model: "explicit", reasoning_effort: "high" }, plain, {
        state: {},
        expanded: false,
      })
      .render(100)[0],
  ).toBe("spawn_agent a explicit high");
  unlinkSync(join(h.ctx.cwd, ".pi/subagents.json"));
  await h.emit("session_start");
  expect(tool.renderCall(args, plain, context).render(100)[0]).toBe("spawn_agent a test-model off");
  expect(
    tool.renderCall({ task_name: "b" }, plain, { state: {}, expanded: false }).render(100),
  ).toEqual(["spawn_agent b"]);
});

it("restores older spawn results using the recorded task path and effective metadata", () => {
  const tool = harness(cleanup).direct.get("spawn_agent");
  const row = host(tool, {
    task_name: "work",
    model: "requested",
    reasoning_effort: "high",
    message: "inspect",
  });
  row.updateResult({
    content: [{ type: "text", text: '{"task_name":"/root/work"}' }],
    details: { subagentType: "worker", modelName: "saved/model", thinking: "low" },
    isError: false,
  });
  expect(rendered(row).filter(Boolean)).toEqual([
    "spawn_agent /root/work worker: saved/model low",
    "inspect",
  ]);
});

it.each([
  ["send_message", "queued"],
  ["followup_task", "submitted"],
])("renders %s acceptance once, keeping its model-facing result empty", async (name, status) => {
  const h = await setupV2(cleanup);
  h.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done again")]);
  await h.call("spawn_agent", { task_name: "audit_auth", message: "inspect" });
  await h.manager.waitForAll();
  const tool = h.direct.get(name);
  const args = {
    target: "audit_auth",
    message: "Check middleware.\nInclude tests.\nReport findings.\n\nMore context.",
  };
  const context = { state: {}, expanded: false, isError: false };
  expect(tool.renderCall(args, theme, context).render(100)[0]).toBe(
    `<b>${name}</b><accent> → audit_auth</accent>`,
  );
  const row = host(tool, args);
  const result = await h.call(name, args);
  expect(result.content).toEqual([{ type: "text", text: "" }]);
  expect(result.value).toBe("");
  row.updateResult({ ...result, isError: false });
  expect(rendered(row).filter(Boolean).slice(0, 4)).toEqual([
    `${name} → /root/audit_auth ${status}`,
    "Check middleware.",
    "Include tests.",
    "Report findings.",
  ]);
  await h.manager.waitForAll();
  await h.emit("session_shutdown");
  const restored = host(tool, args);
  restored.updateResult({ ...JSON.parse(JSON.stringify(result)), isError: false });
  expect(rendered(restored)).toEqual(rendered(row));
  restored.setExpanded(true);
  expect(rendered(restored).filter(Boolean)).toEqual([
    `${name} → /root/audit_auth ${status}`,
    ...args.message.split("\n").filter(Boolean),
  ]);
});

it("uses the configured expansion key and bounds previews by wrapped display lines", async () => {
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
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      const tool = h.direct.get(name);
      const args = {
        task_name: "a\n\x1b[31mb",
        target: "a\n\x1b[31mb",
        agent_type: "explorer",
        message: "abcdefghij".repeat(8) + "\n\x1b]0;malicious\x07你好\x1b[31m tail",
      };
      const context = { state: {}, expanded: false, isError: false };
      const row = tool.renderCall(args, plain, context);
      expect(row.render(30).slice(1, 5)).toEqual([
        "",
        "abcdefghij".repeat(3),
        "abcdefghij".repeat(3),
        "abcdefghij".repeat(2),
      ]);
      expect(stripVTControlCharacters(row.render(30).at(-1)!)).toBe("(alt+e to expand)");
      for (const expanded of [false, true]) {
        const component = host(tool, args);
        component.setExpanded(expanded);
        for (const width of [4, 12, 30, 120]) {
          const lines = rendered(component, width);
          expect(lines.join("\n")).not.toContain("malicious");
          expect(lines.join("\n")).not.toContain("\x1b");
        }
      }
      const short = tool
        .renderCall({ message: "one\ntwo\nthree" }, plain, { state: {}, expanded: false })
        .render(100);
      expect(short.join("\n")).not.toContain("to expand");
    }
  } finally {
    setKeybindings(previous);
  }
});
