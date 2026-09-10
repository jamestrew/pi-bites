import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CodeModeRuntime } from "./code-mode/runtime.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function fixture(source: string, startupTimeoutMs = 1000): CodeModeRuntime {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-connection-"));
  const binary = join(directory, "host");
  writeFileSync(binary, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  const runtime = new CodeModeRuntime({ binary, tools: [], hostLimits: { startupTimeoutMs } });
  cleanup.push(async () => {
    await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

const framing = `
const {readSync, writeSync} = require("node:fs");
function readBytes(length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, bytes, offset, length - offset);
    if (!count) throw new Error("EOF");
    offset += count;
  }
  return bytes;
}
const receive = () => JSON.parse(readBytes(readBytes(4).readUInt32LE(0)).toString());
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  writeSync(1, Buffer.concat([header, body]));
}
receive();
`;

test("missing host fails concurrent startup calls visibly and never falls back", async () => {
  const host = new CodeModeRuntime({ binary: "/nonexistent/code-mode-host", tools: [] });
  cleanup.push(() => host.shutdown());
  const results = await Promise.allSettled([host.execute("text(1)"), host.execute("text(2)")]);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(String(result.reason)).toMatch(/ENOENT.*disable codexAdapter/);
  }
});

test.each([
  ['require("node:fs").writeSync(2, "loader failed"); process.exit(1);', /loader failed/],
  ['require("node:fs").writeSync(1, Buffer.from([255,255,255,255]));', /frame exceeds/],
  [
    `${framing} send({type:"connection/ready", selectedVersion:2, capabilities:[]});`,
    /invalid protocol/,
  ],
  [`${framing} send({type:"connection/rejected", reason:"incompatible"});`, /handshake rejected/],
  [`${framing} send({type:"wrong/message"});`, /unsupported message/],
  ["setInterval(() => {}, 1000);", /startup timed out/],
])("rejects startup errors with bounded cleanup", async (source, diagnostic) => {
  const host = fixture(source, 100);
  await expect(host.execute("text(1)")).rejects.toThrow(diagnostic);
  await expect(host.execute("text(2)")).rejects.toThrow(diagnostic);
});

test("session-open is covered by the startup deadline", async () => {
  const host = fixture(
    `${framing} send({type:"connection/ready", selectedVersion:1, capabilities:[]}); receive(); setInterval(() => {}, 1000);`,
    100,
  );
  await expect(host.execute("text(1)")).rejects.toThrow(/startup timed out/);
});

const readySession = `${framing}
send({type:"connection/ready", selectedVersion:1, capabilities:[]});
const open = receive();
send({type:"operation/response", id:open.id, result:{status:"ok", value:{type:"session/ready", sessionId:open.request.sessionId}}});
const execute = receive();
send({type:"operation/response", id:execute.id, result:{status:"ok", value:{type:"execution/started",cellId:"1"}}});
`;

test.each([
  ['{Result:{cell_id:"1",content_items:[],error_text:123}}', /invalid error text/],
  ['{Result:{cell_id:"wrong",content_items:[],error_text:null}}', /Mismatched.*cell ID/],
  [
    '{Result:{cell_id:"1",content_items:[{type:"input_audio",audio_url:"data:audio/wav;base64,AA=="}],error_text:null}}',
    /audio output is not supported/,
  ],
])(
  "malformed/unsupported runtime responses fail visibly and clear the host",
  async (value, diagnostic) => {
    const host = fixture(
      `${readySession} send({type:"execute/initialResponse",id:execute.id,result:{status:"ok",value:${value}}}); setInterval(() => {}, 1000);`,
    );
    await expect(host.execute("text(1)")).rejects.toThrow(diagnostic);
    await expect(host.execute("text(2)")).rejects.toThrow(diagnostic);
  },
);
