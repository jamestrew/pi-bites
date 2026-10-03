/** Offline execution probe: bun scripts/native-codemode-cli-smoke.ts [PI_EXECUTABLE]. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  let turns = 0;
  pi.registerProvider("native-cli-smoke", {
    api: "openai-completions",
    apiKey: "offline-test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Offline CLI smoke",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
    streamSimple(model) {
      const first = turns++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        content: first
          ? [
              {
                type: "toolCall",
                id: "cli-smoke",
                name: "codemode",
                arguments: { code: "text(6 * 7);" },
              },
            ]
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
}

if (import.meta.main) {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-cli-"));
  try {
    const result = spawnSync(
      process.argv[2]?.includes("/") ? resolve(process.argv[2]) : (process.argv[2] ?? "pi"),
      [
        "--offline",
        "--mode",
        "json",
        "--print",
        "--no-session",
        "-nc",
        "-ns",
        "-np",
        "--no-themes",
        "-ne",
        "-e",
        "builtin:codemode",
        "-e",
        fileURLToPath(import.meta.url),
        "--provider",
        "native-cli-smoke",
        "--model",
        "model",
        "--tools",
        "codemode",
        "run the offline execution probe",
      ],
      {
        cwd: directory,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const events = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const end = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "codemode",
    );
    assert.ok(end, `Missing codemode result:\n${result.stdout}\n${result.stderr}`);
    const output = end.result.content
      .filter((item: { type: string }) => item.type === "text")
      .map((item: { text: string }) => item.text)
      .join("\n");
    assert.equal(end.isError, false, output);
    assert.match(output, /Output:\s*42\s*$/);
    console.log("PASS: installed CLI executed native codemode and emitted 42");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
