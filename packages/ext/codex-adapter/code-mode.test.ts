import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { getCodeModeHostPath, verifyCodeModeHost } from "./code-mode/binary.js";

afterEach(() => vi.unstubAllEnvs());

test("finds executable hosts in PATH order, including symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-installed-"));
  try {
    const entries = ["missing", "nonexecutable", "directory", "first", "second"].map((name) =>
      join(directory, name),
    );
    for (const entry of entries) mkdirSync(entry);
    const helper = "codex-code-mode-host";
    writeFileSync(join(entries[1]!, helper), "not executable", { mode: 0o644 });
    mkdirSync(join(entries[2]!, helper));
    const binary = join(directory, "host");
    writeFileSync(binary, "installed fixture", { mode: 0o755 });
    symlinkSync(binary, join(entries[3]!, helper));
    writeFileSync(join(entries[4]!, helper), "second fixture", { mode: 0o755 });
    vi.stubEnv("PATH", entries.join(delimiter));
    for (const arch of ["x64", "arm64"])
      expect(getCodeModeHostPath("linux", arch)).toBe(join(entries[3]!, helper));
    vi.stubEnv("PATH", relative(process.cwd(), entries[4]!));
    expect(getCodeModeHostPath("linux", "x64")).toBe(join(entries[4]!, helper));
    expect(() => getCodeModeHostPath("darwin", "arm64")).toThrow(/Unsupported.*disable/i);
    expect(() => getCodeModeHostPath("linux", "riscv64")).toThrow(/Unsupported/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing or nonexecutable PATH dependency points to manual installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-absent-"));
  vi.stubEnv("PATH", directory);
  try {
    writeFileSync(join(directory, "codex-code-mode-host"), "not executable", { mode: 0o644 });
    expect(() => getCodeModeHostPath("linux", "x64")).toThrow(/PATH.*manual-installation.*disable/);
    vi.stubEnv("PATH", undefined);
    expect(() => getCodeModeHostPath("linux", "x64")).toThrow(/PATH.*manual-installation.*disable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a protocol v1 startup reply and clean exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-protocol-"));
  const binary = join(directory, "host");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const {readSync, writeSync} = require("node:fs");
function readBytes(length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, bytes, offset, length - offset);
    if (count === 0) throw new Error("unexpected EOF");
    offset += count;
  }
  return bytes;
}
const hello = JSON.parse(readBytes(readBytes(4).readUInt32LE(0)).toString());
if (hello.type !== "connection/hello" || !hello.supportedVersions.includes(1)) {
  throw new Error("expected protocol v1 hello");
}
const body = Buffer.from(JSON.stringify({type:"connection/ready",selectedVersion:1,capabilities:[]}));
const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
writeSync(1, Buffer.concat([header,body]));
if (readSync(0, Buffer.alloc(1), 0, 1) !== 0) throw new Error("expected EOF");
`,
    { mode: 0o755 },
  );
  try {
    await expect(verifyCodeModeHost(binary)).resolves.toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing executable points to manual installation", async () => {
  await expect(verifyCodeModeHost("/nonexistent/pi-bites-code-mode-host")).rejects.toThrow(
    /manual-installation.*disable/,
  );
});

test.each([
  ['require("node:fs").writeSync(1, "not a host protocol");', /oversized handshake/],
  [
    'const b = Buffer.from(JSON.stringify({type:"connection/ready",selectedVersion:2,capabilities:[]})); const h=Buffer.alloc(4); h.writeUInt32LE(b.length); require("node:fs").writeSync(1, Buffer.concat([h,b]));',
    /expected protocol v1 handshake/,
  ],
  ['require("node:fs").writeSync(2, "loader unavailable"); process.exit(1);', /loader unavailable/],
])("rejects an incompatible executable visibly", async (source, diagnostic) => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-binary-"));
  const binary = join(directory, "host");
  writeFileSync(binary, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  try {
    const failure = await verifyCodeModeHost(binary).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(diagnostic);
    expect((failure as Error).message).toMatch(/manual-installation.*disable/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("kills a host that never completes startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-stalled-"));
  const binary = join(directory, "host");
  writeFileSync(binary, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  try {
    await expect(verifyCodeModeHost(binary)).rejects.toThrow(/startup timed out.*disable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
