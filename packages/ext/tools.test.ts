import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import registerTools from "./tools.js";

const fixtureDirs: string[] = [];

async function captureReadTool() {
  const tools = new Map<string, any>();
  registerTools({ registerTool: vi.fn((tool) => tools.set(tool.name, tool)) } as any);
  return tools.get("read");
}

async function fixture(name: string, content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), "pi-bites-read-"));
  fixtureDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("numbered read tool", () => {
  test("returns full text reads in cat -n format, including blank lines", async () => {
    const read = await captureReadTool();
    const path = await fixture("example.txt", "alpha\n\ngamma");

    const result = await read.execute("read", { path });

    expect(result.content).toEqual([
      { type: "text", text: "     1\talpha\n     2\t\n     3\tgamma" },
    ]);
    expect(read.description).toContain("cat -n format");
  });

  test("uses source line numbers for offset and limited reads", async () => {
    const read = await captureReadTool();
    const path = await fixture("example.txt", "first\nsecond\n\nfourth\nfifth");

    const result = await read.execute("read", { path, offset: 2, limit: 2 });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "     2\tsecond\n     3\t\n\n[2 more lines in file. Use offset=4 to continue.]",
      },
    ]);
  });

  test("leaves truncation guidance unnumbered and preserves details", async () => {
    const read = await captureReadTool();
    const path = await fixture(
      "large.txt",
      Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const result = await read.execute("read", { path });
    const text = result.content[0].text as string;

    expect(text).toContain("     1\tline 1");
    expect(text).toContain("  2000\tline 2000");
    expect(text.endsWith("\n\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]")).toBe(
      true,
    );
    expect(text).not.toContain("  2001\t[Showing lines");
    expect(result.details?.truncation?.truncated).toBe(true);
  });

  test("leaves an oversized-line notice unchanged", async () => {
    const read = await captureReadTool();
    const path = await fixture("wide.txt", "x".repeat(51 * 1024));

    const result = await read.execute("read", { path });

    expect(result.content[0].text).toMatch(/^\[Line 1 is .+ exceeds 50(?:\.0)?KB limit\./);
    expect(result.content[0].text).not.toMatch(/^\s+1\t/);
  });

  test("does not number image status text or attachments", async () => {
    const read = await captureReadTool();
    const path = await fixture(
      "pixel.png",
      Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
    );

    const result = await read.execute("read", { path });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/^Read image file \[/);
    expect(result.content.some((content: { type: string }) => content.type === "image")).toBe(true);
  });
});
