import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("exports the latest non-empty assistant message", async () => {
    const registerCommand = vi.fn();
    registerView({ registerCommand } as never);
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const notify = vi.fn();

    await command.handler("", {
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
    expect(await readFile(path, "utf8")).toBe("latest\n");
    expect(notify).toHaveBeenCalledWith(path, "info");
  });
});
