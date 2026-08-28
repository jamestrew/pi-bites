import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

import { formatNativeBinaryError } from "./native-binary-error.js";
import { getBundledViewImagePath } from "./view-image/binary.js";
import { createViewImageTool, parseViewImageOutput } from "./view-image/tool.js";

describe("view_image", () => {
  test("converts the native helper data URL into Pi image content", async () => {
    const runNative = vi.fn(async () => ({
      stdout: '{"image_url":"data:image/png;base64,iVBORw0KGgo=","detail":"original"}\n',
      stderr: "",
      status: 0,
      signal: null,
    }));
    const tool = createViewImageTool({ binaryPath: "/native/view_image", runNative });
    const result = await tool.execute("call", { path: "images/cat.png" }, undefined, undefined, {
      cwd: "/project",
    } as never);

    expect(runNative).toHaveBeenCalledWith({
      binary: "/native/view_image",
      args: [JSON.stringify({ path: "images/cat.png" })],
      cwd: "/project",
      signal: undefined,
      label: "view_image",
    });
    expect(result).toEqual({
      content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      details: { path: "images/cat.png" },
    });
  });

  test("rejects failed or malformed native output", async () => {
    const failed = createViewImageTool({
      binaryPath: "/native/view_image",
      runNative: async () => ({ stdout: "", stderr: "bad image\n", status: 1, signal: null }),
    });
    await expect(
      failed.execute("call", { path: "bad.txt" }, undefined, undefined, {
        cwd: "/project",
      } as never),
    ).rejects.toThrow("bad image. Use exec_command for text files");

    expect(() => parseViewImageOutput('{"image_url":"https://example.com/a.png"}')).toThrow(
      "structured image output",
    );
    expect(() =>
      parseViewImageOutput('{"image_url":"data:text/plain;base64,dGV4dA==","detail":"original"}'),
    ).toThrow("structured image output");
    expect(() =>
      parseViewImageOutput('{"image_url":"data:image/png;base64,not-valid","detail":"original"}'),
    ).toThrow("structured image output");
  });

  test("strips one leading @ and performs no provider or network work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runNative = vi.fn(async () => ({
      stdout: '{"image_url":"data:image/png;base64,AA==","detail":"original"}\n',
      stderr: "",
      status: 0,
      signal: null,
    }));
    const tool = createViewImageTool({ binaryPath: "/native/view_image", runNative });
    try {
      const result = await tool.execute("call", { path: "@images/cat.png" }, undefined, undefined, {
        cwd: "/project",
      } as never);
      expect(runNative).toHaveBeenCalledWith(
        expect.objectContaining({ args: [JSON.stringify({ path: "images/cat.png" })] }),
      );
      expect(result.details).toEqual({ path: "images/cat.png" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("reports unavailable binaries and propagates runner limits and cancellation", async () => {
    const unavailable = createViewImageTool({ binaryPath: null });
    await expect(
      unavailable.execute("call", { path: "a.png" }, undefined, undefined, {
        cwd: "/project",
      } as never),
    ).rejects.toThrow(/not bundled/);

    for (const message of ["view_image output exceeded 67108864 bytes", "Operation aborted"]) {
      const tool = createViewImageTool({
        binaryPath: "/native/view_image",
        runNative: async () => {
          throw new Error(message);
        },
      });
      await expect(
        tool.execute("call", { path: "a.png" }, undefined, undefined, {
          cwd: "/project",
        } as never),
      ).rejects.toThrow(message);
    }
  });

  test.skipIf(process.platform !== "linux")(
    "reports a missing supported-platform binary with native recovery guidance",
    async () => {
      const missing = join(tmpdir(), `missing-view-image-${process.pid}-${Date.now()}`);
      const tool = createViewImageTool({ binaryPath: missing });
      await expect(
        tool.execute("call", { path: "a.png" }, undefined, undefined, {
          cwd: "/project",
        } as never),
      ).rejects.toThrow(/not available at .*Rebuild it from .*vendor\/view-image.*`\/reload`/);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "reports non-executable and invalid native artifacts with recovery guidance",
    () => {
      for (const code of ["EACCES", "ENOEXEC"]) {
        const error = Object.assign(new Error(`spawn view_image ${code}`), { code });
        expect(
          formatNativeBinaryError("view_image", error, { binaryPath: "/native/view_image" }),
        ).toMatch(/cannot run on this system.*vendor\/view-image.*`\/reload`/);
      }
    },
  );

  test("snapshots cwd before asynchronous execution", async () => {
    let stale = false;
    const ctx = {
      get cwd() {
        if (stale) throw new Error("stale ctx cwd");
        return "/project";
      },
    };
    const tool = createViewImageTool({
      binaryPath: "/native/view_image",
      runNative: async () => {
        stale = true;
        return {
          stdout: '{"image_url":"data:image/png;base64,AA==","detail":"original"}\n',
          stderr: "",
          status: 0,
          signal: null,
        };
      },
    });

    await expect(
      tool.execute("call", { path: "a.png" }, undefined, undefined, ctx as never),
    ).resolves.toMatchObject({ content: [{ type: "image" }] });
  });

  test("renders one compact, TUI-safe path scanline and exposes only path", () => {
    const tool = createViewImageTool({ binaryPath: "/native/view_image" });
    expect(Object.keys(tool.parameters.properties)).toEqual(["path"]);
    const fg = vi.fn((_role: string, text: string) => `\u001b[36m${text}\u001b[39m`);
    const bold = vi.fn((text: string) => `\u001b[1m${text}\u001b[22m`);
    const component = tool.renderCall!(
      { path: "images/cat.png\nignored" },
      { fg, bold } as never,
      { cwd: "/project" } as never,
    );
    expect(component.render(80)).toEqual([
      "\u001b[1mView\u001b[22m\u001b[36m images/cat.png ignored\u001b[39m",
    ]);
    expect(bold).toHaveBeenCalledWith("View");
    expect(fg).toHaveBeenCalledWith("accent", " images/cat.png ignored");
    expect(component.render(12)).toHaveLength(1);
    expect(stripVTControlCharacters(component.render(12)[0]!)).toMatch(/^View .*…$/);
    expect(tool.renderResult).toBeUndefined();
  });

  test("uses Pi's inline-image rendering and capability-aware text fallback", () => {
    initTheme("dark");
    const previousCapabilities = getCapabilities();
    const image = {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC",
    } as const;
    const tool = createViewImageTool({ binaryPath: "/native/view_image" });
    const render = () => {
      const component = new ToolExecutionComponent(
        "view_image",
        "call",
        { path: "images/cat.png" },
        { showImages: true },
        tool,
        { requestRender() {} } as never,
        "/project",
      );
      component.updateResult({ content: [image], details: {}, isError: false });
      return component.render(80).join("\n");
    };

    try {
      setCapabilities({ images: null, trueColor: false, hyperlinks: false });
      const fallback = stripVTControlCharacters(render());
      expect(fallback).toContain("View images/cat.png");
      expect(fallback).toContain("[Image: [image/png] 2x1]");

      setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
      const inline = render();
      expect(inline).toContain("\u001b]1337;File=inline=1");
      expect(stripVTControlCharacters(inline)).not.toContain("[Image:");

      const failed = new ToolExecutionComponent(
        "view_image",
        "failed-call",
        { path: "images/bad.txt" },
        { showImages: true },
        tool,
        { requestRender() {} } as never,
        "/project",
      );
      failed.markExecutionStarted();
      failed.setArgsComplete();
      failed.updateResult({
        content: [{ type: "text", text: "invalid or unsupported image" }],
        details: {},
        isError: true,
      });
      failed.setExpanded(true);
      const failure = stripVTControlCharacters(failed.render(80).join("\n"));
      expect(failure.match(/View images\/bad\.txt/g)).toHaveLength(1);
      expect(failure.match(/invalid or unsupported image/g)).toHaveLength(1);
      expect(failure).not.toContain("[Image:");
    } finally {
      setCapabilities(previousCapabilities);
    }
  });

  test("bundles supported Linux x64 and arm64 helpers", () => {
    expect(getBundledViewImagePath("linux", "x64")).toMatch(
      /view-image\/bin\/linux-x64\/view_image$/,
    );
    expect(getBundledViewImagePath("linux", "arm64")).toMatch(
      /view-image\/bin\/linux-arm64\/view_image$/,
    );
    expect(getBundledViewImagePath("darwin", "arm64")).toBeUndefined();
  });

  test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
    "validates supported content natively, independent of path spelling",
    async () => {
      const fixtures = {
        png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC",
        jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwGiiimI//2Q==",
        webp: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v0gUAA=",
        gif: "R0lGODdhAgABAIEAAAECAwAAAAAAAAAAACwAAAAAAgABAAAIBQABAAgIADs=",
        animatedGif:
          "R0lGODlhAQABAIEAAAECAwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAQoAAQAsAAAAAAEAAQCBBAUGAAAAAAAAAAAACAQAAQQEADs=",
        bmp: "Qk0+AAAAAAAAADYAAAAoAAAAAgAAAAEAAAABABgAAAAAAAgAAADEDgAAxA4AAAAAAAAAAAAAAwIBAwIBAAA=",
      } as const;
      const expectedMime = {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/png",
      } as const;
      const directory = mkdtempSync(join(tmpdir(), "pi-bites-view-image-"));
      const tool = createViewImageTool();
      try {
        for (const [format, encoded] of Object.entries(fixtures)) {
          const filename = `${format}.content-does-not-match-extension`;
          const absolute = join(directory, filename);
          writeFileSync(absolute, Buffer.from(encoded, "base64"));
          const path = format === "jpeg" ? absolute : format === "png" ? `@${filename}` : filename;
          if (format === "bmp") {
            await expect(
              tool.execute("call", { path }, undefined, undefined, {
                cwd: directory,
              } as never),
            ).rejects.toThrow(/unsupported image format Bmp/);
          } else if (format === "animatedGif") {
            await expect(
              tool.execute("call", { path }, undefined, undefined, {
                cwd: directory,
              } as never),
            ).rejects.toThrow(/animated GIF images are not supported/);
          } else {
            const result = await tool.execute("call", { path }, undefined, undefined, {
              cwd: directory,
            } as never);
            expect(result.content).toMatchObject([
              { type: "image", mimeType: expectedMime[format as keyof typeof expectedMime] },
            ]);
          }
        }

        writeFileSync(join(directory, "plain.txt"), "not an image");
        await expect(
          tool.execute("call", { path: "plain.txt" }, undefined, undefined, {
            cwd: directory,
          } as never),
        ).rejects.toThrow(/invalid or unsupported image.*Use exec_command for text files/s);
        await expect(
          tool.execute("call", { path: "missing.png" }, undefined, undefined, {
            cwd: directory,
          } as never),
        ).rejects.toThrow(/unable to locate image/);
        await expect(
          tool.execute("call", { path: "." }, undefined, undefined, {
            cwd: directory,
          } as never),
        ).rejects.toThrow(/is not a file/);

        const oversized = join(directory, "oversized.png");
        writeFileSync(oversized, "");
        truncateSync(oversized, 32 * 1024 * 1024 + 1);
        await expect(
          tool.execute("call", { path: oversized }, undefined, undefined, {
            cwd: directory,
          } as never),
        ).rejects.toThrow(/is too large .*max 33554432 bytes/);

        const unreadable = join(directory, "unreadable.png");
        writeFileSync(unreadable, Buffer.from(fixtures.png, "base64"));
        chmodSync(unreadable, 0);
        await expect(
          tool.execute("call", { path: unreadable }, undefined, undefined, {
            cwd: directory,
          } as never),
        ).rejects.toThrow(/unable to read image/);
        chmodSync(unreadable, 0o600);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "cancellation terminates a running helper",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-bites-view-image-abort-"));
      const helper = join(directory, "slow-view-image");
      const pidFile = join(directory, "child.pid");
      writeFileSync(
        helper,
        `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n`,
        { mode: 0o700 },
      );
      const controller = new AbortController();
      const execution = createViewImageTool({ binaryPath: helper }).execute(
        "call",
        { path: "unused.png" },
        controller.signal,
        undefined,
        { cwd: directory } as never,
      );
      try {
        for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        expect(existsSync(pidFile)).toBe(true);
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        controller.abort();
        await expect(execution).rejects.toThrow("Operation aborted");
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        await execution.catch(() => {});
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
