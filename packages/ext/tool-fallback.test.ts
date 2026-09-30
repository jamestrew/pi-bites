import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";

test("Pi's renderer-less extension fallback previews, expands, and fits narrow terminals", async () => {
  // Key hints read the registry in Pi's own TUI instance, which may differ from ours.
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const {
    KeybindingsManager,
    getKeybindings,
    setKeybindings,
    visibleWidth,
  }: typeof import("@earendil-works/pi-tui") = await import(
    pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href
  );
  initTheme("dark");
  const previousKeys = getKeybindings();
  setKeybindings(
    new KeybindingsManager(
      { "app.tools.expand": { defaultKeys: "ctrl+o" } },
      { "app.tools.expand": "alt+e" },
    ),
  );
  try {
    const checks = Array.from(
      { length: 20 },
      (_, i) => `Check ${String(i + 1).padStart(2, "0")}: ✓ passed`,
    );
    const tool = {
      name: "checks",
      label: "Checks",
      description: "List project checks",
      parameters: Type.Object({ project: Type.String() }),
      execute: async () => ({
        content: [{ type: "text" as const, text: checks.join("\n") }],
        details: {},
      }),
    } satisfies ToolDefinition;
    const result = { ...(await tool.execute()), isError: false };
    const component = new ToolExecutionComponent(
      tool.name,
      "checks-call",
      { project: "private-project-argument" },
      { showImages: false },
      tool,
      { requestRender() {} } as never,
      "/project",
    );
    component.markExecutionStarted();
    component.setArgsComplete();

    for (const width of [80, 24]) {
      const render = () => {
        const rows = component.render(width);
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        const lines = rows.map((row) => stripVTControlCharacters(row).trim()).filter(Boolean);
        expect(lines[0]?.startsWith("checks")).toBe(true);
        const joined = lines.join("\n");
        expect(joined.replace(/\s+/g, "")).toContain("private-project-argument");
        expect(joined).not.toContain('"project"');
        return lines;
      };
      component.updateResult(result);
      component.setExpanded(false);
      const collapsed = render();
      const collapsedChecks = collapsed.filter((line) => line.startsWith("Check "));
      expect(collapsedChecks).toEqual(checks.slice(0, 10));
      // Ten short result lines plus heading/arguments and a possibly wrapped hint stay compact.
      expect(collapsed.length).toBeLessThanOrEqual(16);
      expect(collapsed.join(" ")).not.toContain(checks[10]);
      expect(collapsed.join(" ")).toContain("... (10 more lines,");

      component.setExpanded(true);
      expect(render().filter((line) => line.startsWith("Check "))).toEqual(checks);

      component.setExpanded(false);
      component.updateResult({
        ...result,
        content: [{ type: "text", text: checks.slice(0, 2).join("\n") }],
      });
      expect(render().filter((line) => line.startsWith("Check "))).toEqual(checks.slice(0, 2));
    }
  } finally {
    setKeybindings(previousKeys);
  }
});
