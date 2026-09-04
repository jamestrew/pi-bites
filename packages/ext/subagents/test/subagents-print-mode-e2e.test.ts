/**
 * subagents-print-mode-e2e.test.ts — REAL end-to-end subagent runs through the
 * headless print-mode host (`test/helpers/print-mode-runner.ts`).
 *
 * Unlike agent-runner-e2e (which asserts on the gated tool
 * set captured at construction and never drive a turn), these tests drive a real
 * parent turn that calls the `spawn_agent` tool, lets the extension spawn a real child
 * session via the real `runAgent`, and waits for it through the real subagent
 * hold condition — then asserts on what actually flowed back.
 *
 * Deterministic by default: a scripted faux model drives both parent and child
 * (no network). The same runner also drives a real LLM when PI_E2E_LIVE=1 — the
 * `live` describe below is a smoke test for that opt-in path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  cleanupPrintModeTempDirs,
  conversationText,
  invokedToolNames,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

// Real pi-mono (loader + dynamic extension import + two live sessions) — a cold
// run under full-suite CPU contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

afterAll(cleanupPrintModeTempDirs);

describe.skipIf(LIVE)("subagents print-mode e2e (scripted faux, real pi-mono)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("finishes a print-mode tool loop after crossing the custom compaction threshold", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "print-compaction-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-bites.json"),
      JSON.stringify({ autoCompaction: { thresholdTokens: 1 } }),
    );
    writeFileSync(join(cwd, "probe.txt"), "probe");

    run = await runPrintMode({
      cwd,
      prompt: "Read probe.txt, then report completion.",
      usePiPrintMode: true,
      respond: (ctx) =>
        ctx.messages.some(
          (message) =>
            message.role === "toolResult" && (message as { toolName?: string }).toolName === "read",
        )
          ? "PRINT_TOOL_LOOP_COMPLETE"
          : fauxToolCall("read", { path: "probe.txt" }),
    });

    expect(run.responseText).toBe("PRINT_TOOL_LOOP_COMPLETE");
  });

  it("spawns immediately and automatically routes real output back to the parent", async () => {
    run = await runPrintMode({
      prompt: "Delegate the greeting to a subagent.",
      respond: routeBySession({
        parentInitial: agentCall({
          agent_type: "explorer",
          message: "Say hello.",
        }),
        // NON-circular: the parent's final answer reflects whether automatic
        // completion content actually reached its model-visible context.
        parentFinal: (ctx: Context) => {
          const text = ctx.messages
            .flatMap((message) =>
              Array.isArray(message.content)
                ? (message.content as Array<{ text?: string }>).map((block) => block.text ?? "")
                : [],
            )
            .join("\n");
          return `Parent relays: ${text.includes("CHILD_GREETING_OK") ? "CHILD_GREETING_OK" : "CHILD_MISSING"}`;
        },
        subagent: "CHILD_GREETING_OK",
      }),
    });

    // Agent returned its identity immediately; the child output arrived later
    // through automatic completion and drove the parent's final answer.
    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults).toHaveLength(1);
    expect(JSON.parse(toolResults[0]!).agent_id).toBeTruthy();
    expect(toolResults[0]).not.toContain("CHILD_GREETING_OK");
    expect(conversationText(run.parentSession)).toContain("CHILD_GREETING_OK");
    expect(run.responseText).toContain("CHILD_GREETING_OK");
    expect(run.responseText).not.toContain("CHILD_MISSING");
    // Parent t1 (Agent call) + child t1 (reply) + parent t2 (final) = 3 calls.
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("the test host can await an asynchronous child and its automatic completion turn", async () => {
    // The child takes a beat to "think" (a real delay in its faux turn). That
    // delay is what makes the contrast causal and deterministic:
    //   - WITHOUT the hold, the parent's turn ends and the runner tears down
    //     before the child ever streams → the child is abandoned (2 model calls:
    //     parent's tool-call turn + its summary turn; the child never runs).
    //   - WITH the hold, the parent loop blocks in waitForAll() until the child
    //     finishes → the child's own model turn actually runs (≥3 calls).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = async (ctx: Context) => {
      const isParent = (ctx.tools ?? []).some((t) => t.name === "spawn_agent");
      if (!isParent) {
        await sleep(80); // child takes long enough that a non-held parent exits first
        return "CHILD_BG_RAN";
      }
      const spawned = ctx.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "spawn_agent",
      );
      return spawned
        ? "summarized"
        : agentCall({
            message: "Do asynchronous work.",
          });
    };

    // Control: no hold → the child hasn't run by the time the parent turn ends.
    // `modelCalls` is snapshotted at that moment (it's a plain number on the
    // result), so draining afterwards to tear down cleanly doesn't change it.
    const noHold = await runPrintMode({ prompt: "go", hold: false, respond });
    const abandonedCalls = noHold.modelCalls;
    await noHold.manager?.waitForAll(); // let the orphan finish before dispose (avoids stale-ctx)
    await noHold.dispose();

    // Subject: hold on → child runs to completion before the parent finishes.
    run = await runPrintMode({ prompt: "go", hold: true, respond });

    // Agent returns its identity synchronously either way.
    expect(JSON.parse(agentToolResults(run.parentSession)[0]!).agent_id).toBeTruthy();
    // Awaiting is load-bearing only in this test host: production remains non-blocking.
    expect(abandonedCalls).toBe(2); // parent tool-call + summary; child never streamed
    expect(run.modelCalls).toBeGreaterThan(abandonedCalls);
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("keeps a subagent invocation alive across turn-boundary compaction", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-compaction-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-bites.json"),
      JSON.stringify({ autoCompaction: { thresholdTokens: 15_000 } }),
    );
    writeFileSync(join(cwd, "large.txt"), "x".repeat(49_000));

    run = await runPrintMode({
      cwd,
      prompt: "Delegate the compaction probe.",
      maxModelCalls: 8,
      respond: (ctx) => {
        const toolNames = new Set((ctx.tools ?? []).map((tool) => tool.name));
        if (toolNames.has("spawn_agent")) {
          const spawned = ctx.messages.some(
            (message) =>
              message.role === "toolResult" &&
              (message as { toolName?: string }).toolName === "spawn_agent",
          );
          return spawned
            ? "Parent received the completion."
            : agentCall({
                message: "Read large.txt, then report CHILD_RESUMED exactly.",
              });
        }
        if (!toolNames.has("read")) return "## Goal\nContinue the compaction probe.";

        const hasReadResults = ctx.messages.some(
          (message) =>
            message.role === "toolResult" && (message as { toolName?: string }).toolName === "read",
        );
        return hasReadResults
          ? "CHILD_RESUMED"
          : [
              fauxText("Compaction context. ".repeat(2_000)),
              fauxToolCall("read", { path: "large.txt" }, { id: "read-large-1" }),
            ];
      },
    });

    const agentId = JSON.parse(agentToolResults(run.parentSession)[0]!).agent_id;
    const record = run.manager?.getRecord(agentId ?? "") as
      | {
          status: string;
          result?: string;
          error?: string;
          compactionCount: number;
          session?: {
            messages: Array<{ role: string; stopReason?: string; errorMessage?: string }>;
          };
        }
      | undefined;
    expect(record).toMatchObject({
      status: "completed",
      result: "CHILD_RESUMED",
      compactionCount: 1,
    });
    expect(record?.error).toBeUndefined();
    expect(
      record?.session?.messages.some(
        (message) =>
          message.role === "assistant" &&
          (message.stopReason === "aborted" ||
            /operation was aborted/i.test(message.errorMessage ?? "")),
      ),
    ).toBe(false);
    // Parent tool turn + immediate parent follow-up + child tool turn + one
    // summary + one resumed child turn + completion-triggered parent turn.
    expect(run.modelCalls).toBe(6);
  });

  it("errors clearly when faux mode is given no script", async () => {
    await expect(runPrintMode({ prompt: "x" })).rejects.toThrow(/provide `respond` or `steps`/);
  });
});

// Opt-in real-LLM smoke tests — exercise the SAME runner against a live model
// (auto-resolved from the local `pi` login). Skipped unless PI_E2E_LIVE=1.
//
// These are SMOKE tests, not strict assertions: a live model decides whether and
// how to call the tool, so we cover the subset it can be reliably steered into
// (spawn_agent + WaitAgent, automatic completion, and an explorer spawn)
// and assert robust invariants (a real spawn happened and produced output).
// Per-feature determinism lives in the faux suite above, which scripts exact calls.
const LIVE_TIMEOUT = 150_000;

describe.runIf(LIVE)("subagents print-mode e2e (live LLM, opt-in)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "spawn-and-wait — real model waits for a subagent and reports its output",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use spawn_agent with agent_type 'worker' to spawn a subagent whose only task is to reply with the exact " +
          "word PONG. Then use WaitAgent with its returned identity and tell me what it replied.",
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(run.modelCalls).toBe(0); // live mode doesn't use the faux counter
      expect(invokedToolNames(run.parentSession)).toEqual(
        expect.arrayContaining(["spawn_agent", "WaitAgent"]),
      );
      expect(agentToolCalls(run.parentSession)).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent_type: "worker" })]),
      );
      expect(conversationText(run.parentSession)).toMatch(/PONG/i);
      expect(run.responseText).toMatch(/PONG/i);
    },
    LIVE_TIMEOUT,
  );

  it(
    "unconsumed spawn — automatic completion reaches the model",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use spawn_agent with agent_type 'worker' to spawn a subagent whose only task is to reply with the exact word BGPONG. " +
          "Do not call WaitAgent; continue useful work and handle its automatic completion, then tell " +
          "me exactly what it said.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent_type: "worker" })]),
      );
      expect(calls.every((call) => !("run_in_background" in call))).toBe(true);
      expect(JSON.parse(agentToolResults(run.parentSession)[0]!).agent_id).toBeTruthy();
      expect(run.responseText).toMatch(/BGPONG/i);
    },
    LIVE_TIMEOUT,
  );

  it(
    "explorer agent_type — model dispatches a non-default agent type",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use spawn_agent with agent_type 'explorer' to look at the current working " +
          "directory and report a one-line summary of what's there.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent_type: "explorer" })]),
      );
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT,
  );

  it(
    "SELF-SMOKE — the agent drives a multi-feature smoke of its own spawn_agent toolset",
    async () => {
      // Agent-driven (not puppeted): one prompt, the model itself exercises three
      // spawn_agent capabilities in a single session and self-reports. We then assert it
      // genuinely invoked each feature (not just that it claimed to in prose).
      run = await runPrintMode({
        prompt: [
          "You are smoke-testing your own spawn_agent toolset. Do these steps IN ORDER, then print a",
          "final report with one PASS/FAIL line per step:",
          "1) WAIT: use spawn_agent with agent_type 'worker' for a subagent whose only task is to reply with the exact",
          "   token FG_OK. Use WaitAgent once with its identity and confirm you got FG_OK back.",
          "2) AUTOMATIC: use spawn_agent with agent_type 'worker' for another subagent whose only task is to reply with",
          "   the exact token BG_OK. Do not wait or poll; handle its automatic completion and",
          "   confirm you got BG_OK.",
          "3) EXPLORE: use spawn_agent with agent_type 'explorer' to summarize the current",
          "   working directory in one line.",
          "Finish with: 'SELF-SMOKE COMPLETE' followed by the PASS/FAIL lines.",
        ].join("\n"),
        timeoutMs: LIVE_TIMEOUT,
      });

      const calls = agentToolCalls(run.parentSession);
      // Each capability was actually exercised at the tool layer (not just narrated):
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.every((call) => !("run_in_background" in call))).toBe(true);
      expect(invokedToolNames(run.parentSession)).toContain("WaitAgent");
      const roles = calls.map((call) => call.agent_type);
      expect(roles.filter((role) => role === "worker").length).toBeGreaterThanOrEqual(2);
      expect(roles).toContain("explorer");
      // — and the real child outputs materialized in the conversation (a
      //   WaitAgent result + an automatic completion message). We check the
      //   whole transcript, not the final message: the agent's closing report
      //   tends to summarize ("Step 1 PASS") rather than re-echo the raw tokens.
      const transcript = conversationText(run.parentSession);
      expect(transcript).toMatch(/FG_OK/i);
      expect(transcript).toMatch(/BG_OK/i);
      // The agent ran the whole script to completion and self-reported.
      expect(run.responseText).toMatch(/SELF-SMOKE COMPLETE/i);
    },
    LIVE_TIMEOUT,
  );
});
