import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { saveReport } from "./automode-eval.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const directories: string[] = [];
afterEach(() => {
  vi.mocked(renameSync).mockClear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("failed report replacement preserves completed paid measurements", () => {
  const dir = mkdtempSync(join(tmpdir(), "automode-report-"));
  directories.push(dir);
  const file = join(dir, "report.json");
  writeFileSync(file, '{"reviews":1}', { mode: 0o600 });
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("replacement failed");
  });
  expect(() => saveReport(file, { reviews: 2 })).toThrow("replacement failed");
  expect(readFileSync(file, "utf8")).toBe('{"reviews":1}');
  expect(readdirSync(dir)).toEqual(["report.json"]);
  saveReport(file, { reviews: 2 });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ reviews: 2 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("evaluation totals all investigation responses rather than only the final assessment", async () => {
  const { recordReviewResponse } = await import("./automode-eval.ts");
  const row = { scenario: "inspection", phase: "cold" as const, expected: "allow" };
  const reply = (input: number, cacheRead: number, cost: number) => ({
    provider: "provider",
    model: "model",
    stopReason: "stop",
    usage: {
      input,
      cacheRead,
      cacheWrite: 0,
      output: 2,
      totalTokens: input + cacheRead + 2,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  });
  recordReviewResponse(row, reply(100, 200, 0.01) as any);
  recordReviewResponse(row, reply(50, 400, 0.02) as any);
  expect(row).toMatchObject({
    usage: { input: 150, cacheRead: 600, output: 4, totalTokens: 754, cost: { total: 0.03 } },
    responses: [{ servedModel: "provider/model" }, { servedModel: "provider/model" }],
  });
});
