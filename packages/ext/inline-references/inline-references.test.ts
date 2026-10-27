import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import registerInlineReferences, { parseInlineReferences } from "./index.js";

describe("parseInlineReferences", () => {
  test("parses skill and prompt references", () => {
    expect(parseInlineReferences("use $skill:handoff then $prompt:review")).toEqual([
      { kind: "skill", name: "handoff", raw: "$skill:handoff" },
      { kind: "prompt", name: "review", raw: "$prompt:review" },
    ]);
  });

  test("requires token boundary and strips trailing punctuation", () => {
    expect(parseInlineReferences("cost is $5, use($skill:nope) and $skill:triage.")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
    ]);
  });

  test("dedupes by kind and name", () => {
    expect(parseInlineReferences("$skill:triage $skill:triage $prompt:triage")).toEqual([
      { kind: "skill", name: "triage", raw: "$skill:triage" },
      { kind: "prompt", name: "triage", raw: "$prompt:triage" },
    ]);
  });
});

// Preserve the former at-mention regression while moving its event handler here.
test("does not dereference stale extension context after file expansion starts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "inline-references-stale-"));
  try {
    await writeFile(join(cwd, "context.txt"), "FILE_BODY_FIXTURE");
    let finalize!: (
      event: MessageEndEvent,
      ctx: ExtensionContext,
    ) => Promise<MessageEndEventResult | undefined>;
    registerInlineReferences({
      on: (name: string, handler: typeof finalize) => {
        if (name === "message_end") finalize = handler;
      },
      registerMarkdownTransformer: () => {},
    } as unknown as ExtensionAPI);
    const notify = vi.fn();
    const values = { cwd, signal: undefined, ui: { notify } };
    const ctx: Record<string, unknown> = {};
    let stale = false;
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(ctx, key, {
        get() {
          if (stale) throw new Error("stale extension context");
          return value;
        },
      });
    }
    const handling = finalize(
      {
        type: "message_end",
        message: { role: "user", content: "Inspect @context.txt", timestamp: 0 },
      },
      ctx as unknown as ExtensionContext,
    );
    stale = true;
    await expect(handling).resolves.toMatchObject({
      message: { content: expect.stringContaining("FILE_BODY_FIXTURE") },
    });
    expect(notify).toHaveBeenCalledWith("Injected at-mention context: @context.txt", "info");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
