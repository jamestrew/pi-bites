import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import registerView, { formatMarkdown } from "./index.js";

const directory = join(tmpdir(), `pi-view-${process.pid}`);

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("view", () => {
  test("removes outer padding and common code-block indentation", () => {
    expect(
      formatMarkdown(`
        Result:
        More detail.

        \`\`\`ts
            if (ready) {
              run();
            }
        \`\`\`
      `),
    ).toBe(`Result:
More detail.

\`\`\`ts
if (ready) {
  run();
}
\`\`\`
`);
  });

  test("renders the requested assistant messages in a closable Markdown view", async () => {
    initTheme("dark", false);
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const command = registerCommand.mock.calls.find(([name]) => name === "view")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const done = vi.fn();
    const custom = vi.fn(async (factory) => {
      const component = factory(
        { terminal: { rows: 100 }, requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text },
        undefined,
        done,
      );
      const output = component.render(80).join("\n");
      expect(output.indexOf("first")).toBeLessThan(output.indexOf("latest"));
      component.handleInput("\u001b");
    });

    await command.handler("2", {
      mode: "tui",
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "first" }] },
          },
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "latest" }] },
          },
        ],
      },
      ui: { custom },
    });

    expect(custom).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  test("scrolls long Markdown views within the terminal", async () => {
    initTheme("dark", false);
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const command = registerCommand.mock.calls.find(([name]) => name === "view")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const requestRender = vi.fn();
    let component: {
      render: (width: number) => string[];
      handleInput: (data: string) => void;
    } | null = null;

    await command.handler("", {
      mode: "tui",
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n\n"),
                },
              ],
            },
          },
        ],
      },
      ui: {
        custom: async (factory: Function) => {
          component = factory(
            { terminal: { rows: 5 }, requestRender },
            { fg: (_color: string, text: string) => text },
            {
              matches: (data: string, id: string) =>
                data === "custom-down" && id === "tui.select.down",
            },
            vi.fn(),
          );
        },
      },
    });

    const firstPage = component!.render(80).join("\n");
    expect(firstPage).toContain("line 1");
    expect(firstPage).not.toContain("line 10");
    component!.handleInput("custom-down");
    expect(component!.render(80).join("\n")).not.toBe(firstPage);
    component!.handleInput("\u001b[F");
    expect(component!.render(80).join("\n")).toContain("line 10");
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  test("warns when the message count is not a positive integer", async () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const notify = vi.fn();

    for (const name of ["view", "eview"]) {
      const command = registerCommand.mock.calls.find(
        ([registered]) => registered === name,
      )?.[1] as {
        handler: (args: string, ctx: unknown) => Promise<void>;
      };
      await command.handler("2x", { ui: { notify } });
      expect(notify).toHaveBeenLastCalledWith(`Usage: /${name} [positive integer]`, "warning");
    }
  });

  test("defaults to the latest assistant message", async () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const command = registerCommand.mock.calls.find(([name]) => name === "eview")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };

    await command.handler("", {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "first" }] },
          },
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "latest" }] },
          },
        ],
      },
      ui: { notify: vi.fn() },
    });

    expect(await readFile(join(directory, "last-message.md"), "utf8")).toBe("latest\n");
  });

  test("exports the requested number of assistant messages in chronological order", async () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const command = registerCommand.mock.calls.find(([name]) => name === "eview")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const notify = vi.fn();

    await command.handler("2", {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "first" }] },
          },
          { type: "message", message: { role: "user", content: "next" } },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "  latest  " }],
            },
          },
        ],
      },
      ui: { notify },
    });

    const path = join(directory, "last-message.md");
    expect(await readFile(path, "utf8")).toBe("first\n\n---\n\nlatest\n");
    expect(notify).toHaveBeenCalledWith(path, "info");
  });
});
