import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { getCodeModeHostPath, verifyCodeModeHost } from "./code-mode/binary.js";

afterEach(() => vi.unstubAllEnvs());

test("finds manually installed hosts in versioned user data directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-installed-"));
  vi.stubEnv("XDG_DATA_HOME", directory);
  try {
    for (const arch of ["x64", "arm64"]) {
      const binary = join(
        directory,
        "pi-bites/code-mode/rust-v0.145.0",
        `linux-${arch}`,
        "codex-code-mode-host",
      );
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, "installed fixture");
      expect(getCodeModeHostPath("linux", arch)).toBe(binary);
    }
    expect(() => getCodeModeHostPath("darwin", "arm64")).toThrow(/Unsupported.*disable/i);
    expect(() => getCodeModeHostPath("linux", "riscv64")).toThrow(/Unsupported/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing dependency points to manual installation without downloading", () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-absent-"));
  vi.stubEnv("XDG_DATA_HOME", directory);
  try {
    expect(() => getCodeModeHostPath("linux", "x64")).toThrow(/manual-installation.*disable/);
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
