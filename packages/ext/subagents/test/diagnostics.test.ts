import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSubagentDiagnostic,
  getSubagentDiagnosticsFile,
  serializeDiagnosticError,
} from "../diagnostics.js";
import { summarizeProviderPayload, summarizeProviderResponse } from "../runner-diagnostics.js";

describe("subagent diagnostics", () => {
  it("preserves nested error causes and codes", () => {
    const quota = Object.assign(new Error("429 quota exceeded"), { code: 429 });
    const aborted = new Error("The operation was aborted.", { cause: quota });

    expect(serializeDiagnosticError(aborted)).toMatchObject({
      name: "Error",
      message: "The operation was aborted.",
      cause: { name: "Error", message: "429 quota exceeded", code: 429 },
    });
  });

  it("summarizes requests without retaining prompt content", () => {
    const summary = summarizeProviderPayload({
      model: "model",
      input: [{ role: "user", content: "secret prompt" }],
      tools: [{ name: "read", description: "secret tool description" }],
      previous_response_id: "response-1",
    });

    expect(summary).toMatchObject({
      kind: "object",
      input_count: 1,
      tool_count: 1,
      has_previous_response_id: true,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("retains rate-limit metadata but strips sensitive response headers", () => {
    expect(
      summarizeProviderResponse({
        status: 429,
        headers: {
          "retry-after": "12",
          "x-request-id": "request-1",
          "set-cookie": "secret",
          authorization: "secret",
        },
      }),
    ).toEqual({
      status: 429,
      headers: { "retry-after": "12", "x-request-id": "request-1" },
    });
  });

  it("appends ordered JSONL records in the diagnostics directory", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(join(tmpdir(), "pi-bites-diagnostics-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const base = {
      type: "subagent_diagnostic" as const,
      version: 1 as const,
      timestamp: 123,
      agentId: "agent-1",
      parentSessionId: "parent-1",
      subagent: "general",
      pid: process.pid,
    };

    try {
      await Promise.all([
        appendSubagentDiagnostic({ ...base, event: "first" }),
        appendSubagentDiagnostic({ ...base, event: "second" }),
      ]);
      const content = await readFile(getSubagentDiagnosticsFile(), "utf8");
      expect(
        content
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).event),
      ).toEqual(["first", "second"]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
