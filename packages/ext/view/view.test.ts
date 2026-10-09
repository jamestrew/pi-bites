import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import registerView, { formatMarkdown } from "./index.js";

const directory = join(tmpdir(), `pi-view-${process.pid}`);

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("eview", () => {
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

  test("registers only the export command", () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(["eview"]);
  });

  test("warns when the message count is not a positive integer", async () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const notify = vi.fn();

    const command = registerCommand.mock.calls.find(([name]) => name === "eview")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    await command.handler("2x", { ui: { notify } });
    expect(notify).toHaveBeenLastCalledWith("Usage: /eview [positive integer]", "warning");
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
