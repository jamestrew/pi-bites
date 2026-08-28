import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

import { getBundledExecBridgePath } from "./exec/binary.js";
import { createExecCommandTool } from "./exec/command-tool.js";
import { createPipeOutputNormalizer } from "./exec/output.js";
import { createExecSessionManager } from "./exec/session-manager.js";
import { createWriteStdinTool } from "./exec/write-stdin-tool.js";

const dirs: string[] = [];
const managers: Array<ReturnType<typeof createExecSessionManager>> = [];
const bash = getShellConfig().shell;
const noHookWarning =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-bites-exec-"));
  dirs.push(dir);
  return dir;
}

function manager(options: Parameters<typeof createExecSessionManager>[0] = {}) {
  const sessions = createExecSessionManager({
    bridgeBinaryPath: () => getBundledExecBridgePath(),
    minNonInteractiveExecYieldTimeMs: 250,
    minEmptyWriteYieldTimeMs: 250,
    maxEmptyWriteYieldTimeMs: 1_000,
    ...options,
  });
  managers.push(sessions);
  return sessions;
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(10);
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((sessions) => sessions.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exec_command and write_stdin", () => {
  test("filters an RTK warning split across native output chunks", async () => {
    const sessions = manager();
    const result = await sessions.exec(
      {
        cmd: `printf '%s' '${noHookWarning}' >&2; sleep 0.1; printf '\\nneighbor' >&2`,
        defaultShell: bash,
        filterRtkOutput: true,
      },
      tempDir(),
    );

    expect(result.output).toBe("neighbor");
  });

  test("preserves warning-like output when RTK did not rewrite the command", async () => {
    const sessions = manager();
    const result = await sessions.exec(
      { cmd: `printf '%s\\n' '${noHookWarning}'`, defaultShell: bash },
      tempDir(),
    );

    expect(result.output).toBe(`${noHookWarning}\n`);
  });

  test("filters delayed warning terminators per output stream", async () => {
    const sessions = manager();
    const result = await sessions.exec(
      {
        cmd: `printf '%s' '${noHookWarning}' >&2; printf 'a\\n\\nB' >&1; printf '\\r\\n' >&2`,
        defaultShell: bash,
        filterRtkOutput: true,
      },
      tempDir(),
    );

    expect(result.output).toBe("a\n\nB");
  });

  test("preserves cross-stream order while resolving warning candidates", async () => {
    const sessions = manager();
    const result = await sessions.exec(
      {
        cmd: "printf '[' >&2; sleep 0.1; printf B; sleep 0.1; printf X >&2",
        defaultShell: bash,
        filterRtkOutput: true,
      },
      tempDir(),
    );

    expect(result.output).toBe("[BX");
  });

  test("renders one styled scanline and collapsible dim details", () => {
    const tool = createExecCommandTool({} as never);
    const theme = {
      bold: (text: string) => `<bold>${text}</bold>`,
      fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    };
    const call = tool.renderCall!({ cmd: "printf one\nprintf two" }, theme as never, {} as never)
      .render(200)
      .map((line) => line.trimEnd());
    expect(call).toEqual(["<bold>Exec</bold><toolTitle> printf one", "printf two</toolTitle>"]);

    const result = {
      content: [{ type: "text" as const, text: "unused structured output" }],
      details: {
        chunk_id: "abc123",
        wall_time_seconds: 1.25,
        exit_code: 0,
        output: `${Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
      },
    };
    const collapsed = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme as never,
      { state: {} } as never,
    )
      .render(200)
      .map((line) => line.trimEnd());
    expect(collapsed[0]).toBe("");
    expect(collapsed.join("\n")).not.toContain("line 5");
    expect(collapsed.join("\n")).toContain("<dim>line 10</dim>");
    expect(collapsed.at(-3)).toBe("");
    expect(collapsed.at(-2)).toBe("<dim>Took 1.3s · ~6 input tokens</dim>");
    expect(collapsed.at(-1)).toContain("<dim>... (5 earlier lines,");
    expect(collapsed.at(-1)).toContain("to expand");
    expect(collapsed.at(-1)?.endsWith("<dim>)</dim>")).toBe(true);

    const expanded = tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      theme as never,
      { state: {} } as never,
    )
      .render(200)
      .join("\n");
    expect(expanded).toContain("<dim>line 10</dim>");
    expect(expanded).not.toContain("earlier lines");
  });

  test("renders polls with the original command, output, and final status", () => {
    const sessions = {
      getSessionCommand: () => "echo started\nsleep 5\necho finished",
    } as never;
    const tool = createWriteStdinTool(sessions);
    const theme = {
      bold: (text: string) => `<bold>${text}</bold>`,
      fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    };
    const renderCall = (chars?: string) =>
      tool.renderCall!(
        { session_id: 6, ...(chars === undefined ? {} : { chars }) },
        theme as never,
        {
          state: {},
        } as never,
      )
        .render(200)
        .map((line) => line.trimEnd());
    const pollScanline = [
      "<bold>Poll</bold><toolTitle> echo started",
      "sleep 5",
      "echo finished</toolTitle>",
    ];
    expect(renderCall()).toEqual(pollScanline);
    expect(renderCall("")).toEqual(pollScanline);
    expect(renderCall("\n")[0]).toBe("<bold>Input</bold><toolTitle> echo started");

    const rendered = tool.renderResult!(
      {
        content: [{ type: "text", text: "unused" }],
        details: {
          chunk_id: "abc123",
          wall_time_seconds: 0.42,
          exit_code: 0,
          output: "\nresumed\nand finished\n",
        },
      },
      { expanded: false, isPartial: false },
      theme as never,
      { state: {}, isError: false } as never,
    )
      .render(200)
      .map((line) => line.trimEnd());
    expect(rendered).toEqual([
      "",
      "<dim>resumed</dim>",
      "<dim>and finished</dim>",
      "",
      "<dim>Took 0.4s · ~2 input tokens</dim>",
    ]);
  });

  test("renders TTY, partial, yielded, and frozen error lifecycle states within width", () => {
    const tool = createExecCommandTool({} as never);
    const theme = { bold: (text: string) => text, fg: (_role: string, text: string) => text };
    expect(
      tool.renderCall!({ cmd: "read value", tty: true }, theme as never, { state: {} } as never)
        .render(80)
        .map((line) => line.trimEnd()),
    ).toEqual(["Exec read value (TTY)"]);

    const partial = tool.renderResult!(
      {
        content: [{ type: "text", text: "" }],
        details: {
          chunk_id: "partial",
          wall_time_seconds: 0.42,
          session_id: 123,
          output: "live",
        },
      },
      { expanded: false, isPartial: true },
      theme as never,
      { state: {}, isError: false } as never,
    )
      .render(16)
      .map((line) => line.trimEnd());
    expect(partial).toEqual(["", "live", "", "Elapsed 0.4s"]);

    const yielded = tool.renderResult!(
      {
        content: [{ type: "text", text: "" }],
        details: {
          chunk_id: "yielded",
          wall_time_seconds: 1,
          session_id: 123,
          output: "",
        },
      },
      { expanded: false, isPartial: false },
      theme as never,
      { state: {}, isError: false } as never,
    ).render(16);
    expect(yielded.join("\n")).toContain("Running in");
    expect(yielded.every((line) => stripVTControlCharacters(line).length <= 16)).toBe(true);

    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    try {
      const state = { startedAt: 1_000 };
      const error = {
        content: [{ type: "text" as const, text: "failed\n\nCommand exited with code 9" }],
      } as never;
      const first = tool.renderResult!(
        error,
        { expanded: false, isPartial: false },
        theme as never,
        { state, isError: true } as never,
      ).render(80);
      now.mockReturnValue(5_000);
      const rerendered = tool.renderResult!(
        error,
        { expanded: true, isPartial: false },
        theme as never,
        { state, isError: true } as never,
      ).render(80);
      expect(first.at(-1)?.trimEnd()).toBe("Took 1.0s · ~9 input tokens");
      expect(rerendered.at(-1)?.trimEnd()).toBe("Took 1.0s · ~9 input tokens");
    } finally {
      now.mockRestore();
    }
  });

  test("keeps rendered exec lines within the visible width", () => {
    const tool = createExecCommandTool({} as never);
    const theme = { bold: (text: string) => text, fg: (_role: string, text: string) => text };
    const result = {
      content: [{ type: "text" as const, text: "" }],
      details: {
        chunk_id: "abc123",
        wall_time_seconds: 0,
        exit_code: 0,
        output: "a very long output line that must wrap safely ".repeat(20),
      },
    };
    const lines = [
      ...tool.renderCall!(
        { cmd: "a very long command that must wrap safely" },
        theme as never,
        {} as never,
      ).render(16),
      ...tool.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme as never,
        { state: {} } as never,
      ).render(16),
    ];
    expect(lines.every((line) => stripVTControlCharacters(line).length <= 16)).toBe(true);
    expect(stripVTControlCharacters(lines[0]!)).toHaveLength(16);
    expect(
      tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme as never,
        { state: {} } as never,
      ).render(16),
    ).toHaveLength(9);
  });

  test("sanitizes terminal controls in commands and output", () => {
    const tool = createExecCommandTool({} as never);
    const theme = {
      bold: (text: string) => `<bold>${text}</bold>`,
      fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    };
    const call = tool.renderCall!(
      { cmd: "printf ok\u001b]2;changed title\u0007\u0000" },
      theme as never,
      { state: {} } as never,
    )
      .render(200)
      .join("\n");
    expect(call).not.toContain("changed title");
    expect(call).not.toContain("\u0000");

    const result = {
      content: [{ type: "text" as const, text: "" }],
      details: {
        chunk_id: "abc123",
        wall_time_seconds: 0,
        exit_code: 0,
        output: "\n\u001b[31mred\u001b[0m\u0000ok\n\n",
      },
    };
    const rendered = tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      theme as never,
      { state: {} } as never,
    )
      .render(200)
      .join("\n");
    expect(rendered).toContain("<dim>redok</dim>");
    expect(rendered).not.toContain("\u001b[31m");
    expect(rendered).not.toContain("\u0000");
    expect(rendered.startsWith("\n<dim>redok</dim>")).toBe(true);
    expect(rendered.startsWith("\n\n")).toBe(false);
    expect(rendered.endsWith("\n")).toBe(false);
  });

  test("returns foreground output, status, elapsed details, and the configured shell", async () => {
    const cwd = tempDir();
    const sessions = manager();
    const tool = createExecCommandTool(sessions);
    let stale = false;
    const ctx = {
      get cwd() {
        if (stale) throw new Error("stale ctx cwd");
        return cwd;
      },
      isProjectTrusted() {
        if (stale) throw new Error("stale ctx trust");
        return true;
      },
    };

    const resultPromise = tool.execute(
      "foreground",
      {
        cmd: "printf '%s:%s:out' \"$0\" \"$PWD\"; printf ':err' >&2",
        yield_time_ms: 2_000,
        login: false,
      },
      undefined,
      undefined,
      ctx as never,
    );
    stale = true;
    const result = await resultPromise;

    expect(result.details).toMatchObject({ exit_code: 0, output: expect.stringContaining(cwd) });
    expect(result.details.output).toContain(bash);
    expect(result.details.output).toContain("out");
    expect(result.details.output).toContain("err");
    expect(result.details.wall_time_seconds).toBeGreaterThanOrEqual(0);
    expect(result.details.chunk_id).toMatch(/^[a-f0-9]{6}$/);
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/Process exited with code 0[\s\S]*Output:/),
    });
  });

  test("rejects nonzero exits so Pi renders the error background", async () => {
    const tool = createExecCommandTool(manager());
    await expect(
      tool.execute(
        "failure",
        { cmd: "printf oops; exit 7", yield_time_ms: 2_000, login: false },
        undefined,
        undefined,
        { cwd: tempDir(), isProjectTrusted: () => true } as never,
      ),
    ).rejects.toThrow("oops\n\nCommand exited with code 7");
  });

  test("keeps upstream parameter names and canonicalizes compatibility aliases", () => {
    const sessions = manager();
    const exec = createExecCommandTool(sessions);
    const write = createWriteStdinTool(sessions);
    expect(Object.keys(exec.parameters.properties)).toEqual([
      "cmd",
      "workdir",
      "shell",
      "tty",
      "yield_time_ms",
      "max_output_tokens",
      "login",
    ]);
    expect(exec.parameters.properties.cmd).toMatchObject({
      description: expect.stringContaining("interpreted by the current shell"),
    });
    expect(exec.parameters.properties.yield_time_ms).toMatchObject({
      description: expect.stringContaining("Defaults to 30000 ms"),
    });
    expect(exec.parameters.properties.max_output_tokens).toMatchObject({
      description: expect.stringContaining("Defaults to 10000 tokens"),
    });
    expect(
      exec.prepareArguments?.({
        command: "pwd",
        cwd: "sub",
        yield_time: 500,
        future: { preserved: true },
      }),
    ).toMatchObject({
      cmd: "pwd",
      workdir: "sub",
      yield_time_ms: 500,
      future: { preserved: true },
    });
    expect(Object.keys(write.parameters.properties)).toEqual([
      "session_id",
      "chars",
      "yield_time_ms",
      "max_output_tokens",
    ]);
    expect(write.parameters.properties.chars).toMatchObject({
      description: expect.stringContaining("pass empty to poll"),
    });
    expect(write.parameters.properties.yield_time_ms).toMatchObject({
      description: expect.stringContaining("empty polls default to 30000 ms"),
    });
    expect(write.parameters.properties.max_output_tokens).toMatchObject({
      description: expect.stringContaining("Defaults to 10000 tokens"),
    });
    expect(write.prepareArguments?.({ process_id: 7, input: "x", yield_time: 500 })).toEqual({
      session_id: 7,
      chars: "x",
      yield_time_ms: 500,
    });
  });

  test("yields a background session and polls it to completion", async () => {
    const sessions = manager();
    const started = await sessions.exec(
      { cmd: "printf start; sleep .35; printf end", yield_time_ms: 250, login: false },
      tempDir(),
    );
    expect(started).toMatchObject({ session_id: 1, output: "start" });

    const completed = await sessions.write({ session_id: 1, yield_time_ms: 1_000 });
    expect(completed).toMatchObject({ exit_code: 0, output: "end" });
    expect(completed.session_id).toBeUndefined();
  });

  test("executes a rewritten command but keeps the original session label", async () => {
    const sessions = manager();
    const started = await sessions.exec(
      {
        cmd: "printf rewritten; sleep .35",
        displayCommand: "printf original",
        yield_time_ms: 250,
        defaultShell: bash,
        login: false,
      },
      tempDir(),
    );

    expect(started.output).toBe("rewritten");
    expect(sessions.getSessionCommand(started.session_id!)).toBe("printf original");
  });

  test("rejects a polled nonzero exit so Pi renders the error background", async () => {
    const sessions = manager();
    const started = await sessions.exec(
      { cmd: "printf start; sleep .35; printf failed; exit 9", yield_time_ms: 250, login: false },
      tempDir(),
    );
    await expect(
      createWriteStdinTool(sessions).execute(
        "poll-failure",
        { session_id: started.session_id!, yield_time_ms: 1_000 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("failed\n\nCommand exited with code 9");
  });

  test("extends foreground and empty-poll waits while output remains active", async () => {
    const sessions = manager();
    const activeCommand = "for value in 1 2 3 4 5 6; do printf $value; sleep .1; done; printf done";
    const foreground = await sessions.exec(
      {
        cmd: activeCommand,
        yield_time_ms: 250,
        max_yield_time_ms: 1_000,
        login: false,
      },
      tempDir(),
    );
    expect(foreground).toMatchObject({ exit_code: 0, output: "123456done" });

    const background = await sessions.exec(
      {
        cmd: "sleep .3; for value in 1 2 3 4 5; do printf $value; sleep .1; done; printf done",
        yield_time_ms: 250,
        max_yield_time_ms: 250,
        login: false,
      },
      tempDir(),
    );
    expect(background.session_id).toBe(2);
    const completed = await sessions.write({ session_id: 2, yield_time_ms: 250 });
    expect(completed).toMatchObject({ exit_code: 0, output: "12345done" });
  });

  test("includes already-unread output in partial poll updates", async () => {
    const sessions = manager();
    const started = await sessions.exec(
      {
        cmd: "printf first; sleep .35; printf unread; sleep .35; printf final",
        yield_time_ms: 250,
        max_yield_time_ms: 250,
        login: false,
      },
      tempDir(),
    );
    expect(started).toMatchObject({ session_id: 1, output: "first" });
    await delay(450);

    const updates: string[] = [];
    const completed = await sessions.write(
      { session_id: 1, yield_time_ms: 1_000 },
      undefined,
      (update) => updates.push(update.output),
    );
    expect(updates[0]).toContain("unread");
    expect(completed).toMatchObject({ exit_code: 0, output: "unreadfinal" });
  });

  test("accepts TTY input and control-C interruption", async () => {
    const sessions = manager();
    const writeStdin = createWriteStdinTool(sessions);
    const interactive = await sessions.exec(
      {
        cmd: "read value; printf 'got:%s\\n' \"$value\"",
        shell: bash,
        tty: true,
        yield_time_ms: 250,
        login: false,
      },
      tempDir(),
    );
    expect(interactive.session_id).toBe(1);

    const answered = await writeStdin.execute(
      "input",
      { session_id: 1, chars: "hello\n", yield_time_ms: 1_000 },
      undefined,
      undefined,
      {} as never,
    );
    expect(answered.details).toMatchObject({ exit_code: 0 });
    expect(answered.details.output).toContain("got:hello");

    const interruptible = await sessions.exec(
      {
        cmd: "trap 'printf interrupted; exit 130' INT; printf ready; while :; do sleep 1; done",
        shell: bash,
        tty: true,
        yield_time_ms: 250,
        login: false,
      },
      tempDir(),
    );
    expect(interruptible).toMatchObject({
      session_id: 2,
      output: expect.stringContaining("ready"),
    });
    const interrupted = await sessions.write({
      session_id: 2,
      chars: "\u0003",
      yield_time_ms: 2_000,
    });
    expect(interrupted.exit_code).toBe(130);
    expect(interrupted.output).toContain("interrupted");
  });

  test("aborts startup and running descendant process groups", async () => {
    const cwd = tempDir();
    const pidFile = join(cwd, "child.pid");
    const sessions = manager();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sessions.exec({ cmd: "echo no", login: false }, cwd, controller.signal),
    ).rejects.toThrow(/aborted/i);

    const runningController = new AbortController();
    const running = sessions.exec(
      {
        cmd: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        yield_time_ms: 5_000,
        login: false,
      },
      cwd,
      runningController.signal,
    );
    await waitUntil(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(processIsRunning(childPid)).toBe(true);
    runningController.abort();
    await expect(running).rejects.toThrow(/aborted/i);
    await waitUntil(() => !processIsRunning(childPid));
  });

  test("bounds output with deterministic tail and truncation metadata", async () => {
    const sessions = manager({ maxSessionBufferChars: 512 });
    const result = await sessions.exec(
      {
        cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(5000) + 'TAIL')")}`,
        max_output_tokens: 64,
        yield_time_ms: 2_000,
        login: false,
      },
      tempDir(),
    );

    expect(result.exit_code).toBe(0);
    expect(result.output).toMatch(/^\[Earlier output truncated\]\n/);
    expect(result.output).toHaveLength(256);
    expect(result.output.endsWith("TAIL")).toBe(true);
    expect(result.original_token_count).toBe(1_251);
  });

  test("normalizes pipe control sequences across native chunk boundaries", () => {
    const normalizer = createPipeOutputNormalizer();
    expect(normalizer.write("line\r")).toBe("line");
    expect(normalizer.write("\n\u001B[")).toBe("\n");
    expect(normalizer.write("31mred\u001B]title")).toBe("red");
    expect(normalizer.write("\u0007tail\r")).toBe("tail");
    expect(normalizer.end()).toBe("\n");
  });

  test("accounts for output dropped by the native retention cap", async () => {
    const sessions = createExecSessionManager({
      bridgeBinaryPath: () => getBundledExecBridgePath(),
      minNonInteractiveExecYieldTimeMs: 1,
      maxSessionBufferChars: 1_024,
    });
    managers.push(sessions);
    const outputChars = 20 * 1024 * 1024 + 4;
    const result = await sessions.exec(
      {
        cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(20 * 1024 * 1024) + 'TAIL')")}`,
        yield_time_ms: 5_000,
        max_output_tokens: 250,
        login: false,
      },
      tempDir(),
    );
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("[Earlier output truncated]");
    expect(result.output.endsWith("TAIL")).toBe(true);
    expect(result.original_token_count).toBe(Math.ceil(outputChars / 4));
  }, 20_000);

  test("isolates concurrent, unknown, completed, and closed sessions", async () => {
    const sessions = manager();
    const [one, two] = await Promise.all([
      sessions.exec({ cmd: "sleep .4; printf one", yield_time_ms: 250, login: false }, tempDir()),
      sessions.exec({ cmd: "sleep 60; printf two", yield_time_ms: 250, login: false }, tempDir()),
    ]);
    expect([one.session_id, two.session_id].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2]);
    await expect(sessions.write({ session_id: 99, chars: "x" })).rejects.toThrow(
      /unknown process id 99/i,
    );

    const completedOne = await sessions.write({
      session_id: one.session_id!,
      yield_time_ms: 1_000,
    });
    expect(completedOne).toMatchObject({ exit_code: 0, output: "one" });
    expect(sessions.hasSession(two.session_id!)).toBe(true);
    await expect(sessions.write({ session_id: one.session_id!, chars: "x" })).rejects.toThrow(
      /already completed with exit code 0/i,
    );
    await expect(sessions.write({ session_id: one.session_id! })).rejects.toThrow(
      /already completed with exit code 0/i,
    );

    sessions.terminateSession(two.session_id!);
    const closedTwo = await sessions.write({ session_id: two.session_id!, yield_time_ms: 1_000 });
    expect(closedTwo.exit_code).not.toBe(0);
    await expect(sessions.write({ session_id: two.session_id!, chars: "x" })).rejects.toThrow(
      /already completed/i,
    );
  });

  test("shutdown terminates every owned process and is idempotent", async () => {
    const cwd = tempDir();
    const sessions = manager();
    const firstPidFile = join(cwd, "first.pid");
    const secondPidFile = join(cwd, "second.pid");
    await Promise.all([
      sessions.exec(
        { cmd: `echo $$ > ${JSON.stringify(firstPidFile)}; sleep 60`, yield_time_ms: 250 },
        cwd,
      ),
      sessions.exec(
        { cmd: `echo $$ > ${JSON.stringify(secondPidFile)}; sleep 60`, yield_time_ms: 250 },
        cwd,
      ),
    ]);
    const pids = [firstPidFile, secondPidFile].map((file) => Number(readFileSync(file, "utf8")));
    expect(pids.every(processIsRunning)).toBe(true);

    await sessions.shutdown();
    await sessions.shutdown();
    await waitUntil(() => pids.every((pid) => !processIsRunning(pid)));
    await expect(sessions.exec({ cmd: "echo no" }, cwd)).rejects.toThrow(/shut down/i);
  });

  test("bundles Linux x64 and arm64 bridges", () => {
    expect(getBundledExecBridgePath("linux", "x64")).toBeDefined();
    expect(getBundledExecBridgePath("linux", "arm64")).toBeDefined();
    expect(getBundledExecBridgePath("darwin", "x64")).toBeUndefined();
  });
});
