import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CodeModeRuntime } from "./code-mode/runtime.js";
import type { RuntimeTool } from "./code-mode/types.js";

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
  [{ namespace: "multi_agent_v1", name: "spawn_agent" }, true],
  [{ namespace: "other", name: "spawn_agent" }, false],
  [{ namespace: "multi_agent", name: "v1__spawn_agent" }, false],
  [{ name: "multi_agent_v1__spawn_agent" }, false],
  [{ name: "spawn_agent" }, false],
] as const)("authorizes exact native tool identity %j", async (toolName, allowed) => {
  const host = fixture(`${readySession}
send({type:"delegate/request", id:42, sessionId:open.request.sessionId,
  request:{type:"tool/invoke",invocation:{cell_id:"1",runtime_tool_call_id:"call",
    tool_kind:"function",tool_name:${JSON.stringify(toolName)},input:{task:"test"}}}});
const reply = receive();
send({type:"execute/initialResponse",id:execute.id,result:{status:"ok",value:{Result:{
  cell_id:"1",error_text:null,content_items:[{type:"input_text",text:JSON.stringify({
    metadata:execute.request.request.enabled_tools[0],reply:reply.result
  })}]
}}}});
setInterval(() => {}, 1000);
`);
  let calls = 0;
  const tool: RuntimeTool = {
    name: "multi_agent_v1__spawn_agent",
    toolName: { namespace: "multi_agent_v1", name: "spawn_agent" },
    description: "Spawn an agent",
    kind: "function",
    invoke: async (input) => {
      calls++;
      return input;
    },
  };
  const response = await host.execute("text(1)", undefined, [tool]);
  const item = response.contentItems[0];
  expect(item?.type).toBe("input_text");
  const result = JSON.parse(item?.type === "input_text" ? item.text : "{}");
  expect(result.metadata).toMatchObject({
    name: "multi_agent_v1__spawn_agent",
    tool_name: { namespace: "multi_agent_v1", name: "spawn_agent" },
  });
  expect(result.reply).toEqual(
    allowed
      ? { status: "ok", value: { type: "tool/result", result: { task: "test" } } }
      : { status: "error", message: expect.stringContaining("Unknown Code Mode tool") },
  );
  expect(calls).toBe(allowed ? 1 : 0);
});

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
