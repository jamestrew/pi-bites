import { afterEach, describe, expect, test, vi } from "vitest";

import registerBashGate from "./bash-gate/index.js";
import { createExecCommandTool } from "./codex-adapter/exec/command-tool.js";
import registerRtk, {
  consumeRtkExecInput,
  createRtkNoHookWarningDataFilter,
  stripRtkNoHookWarning,
} from "./rtk.js";

const noHookWarning =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";

afterEach(() => {
  delete process.env.RTK_DISABLED;
  vi.restoreAllMocks();
});

function createRtkHarness(
  exec = vi.fn(async (_command: string, args: string[]) => ({
    code: 0,
    killed: false,
    stdout: `rtk ${args[1]}`,
  })),
) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    exec,
    on: vi.fn((name: string, handler: (event: any, ctx: any) => any) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
  };
  registerRtk(pi as any);
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    hasUI: true,
    ui: { notify: vi.fn() },
  };
  return {
    controller,
    ctx,
    exec,
    handler: (name: string) => handlers.get(name)![0]!,
  };
}

describe("RTK output filtering", () => {
  test("strips no-hook warning from tool output", () => {
    expect(stripRtkNoHookWarning(`stdout\n${noHookWarning}\nstderr\n`)).toBe("stdout\nstderr\n");
  });

  test("preserves adjacent text after a warning candidate across chunks", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(noHookWarning));
    onData(Buffer.from("85e8af4 commit output\n"));
    onData(Buffer.from("\n"));

    expect(chunks.join("")).toBe(`${noHookWarning}85e8af4 commit output\n\n`);
  });

  test("preserves byte order when a warning candidate and CR are not followed by LF", () => {
    const raw = `${noHookWarning}\rtail\n`;
    for (let split = 1; split < raw.length; split += 1) {
      const chunks: Buffer[] = [];
      const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data));
      onData(Buffer.from(raw.slice(0, split)));
      onData(Buffer.from(raw.slice(split)));
      onData.end();
      expect(Buffer.concat(chunks).toString(), `split ${split}`).toBe(raw);
    }
  });

  test("strips no-hook warning from streamed bash output", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(`${noHookWarning.slice(0, 12)}`));
    onData(Buffer.from(`${noHookWarning.slice(12)}\nkept\n`));

    expect(chunks.join("")).toBe("kept\n");
  });

  test("strips the warning at every streamed chunk boundary and flushes other tails", () => {
    for (let split = 1; split < noHookWarning.length; split += 1) {
      const chunks: string[] = [];
      const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));
      onData(Buffer.from(noHookWarning.slice(0, split)));
      onData(Buffer.from(`${noHookWarning.slice(split)}\r`));
      onData(Buffer.from("\nneighbor"));
      onData.end();
      expect(chunks.join(""), `split ${split}`).toBe("neighbor");
    }
  });

  test("preserves warning-like text that is not a complete line", () => {
    const cases = [
      [`prefix${noHookWarning}\n`, `prefix${noHookWarning}\n`],
      [`${noHookWarning}tail\n`, `${noHookWarning}tail\n`],
    ];
    for (const [raw, expected] of cases) {
      const chunks: Buffer[] = [];
      const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data));
      onData(Buffer.from(raw!));
      onData.end();
      expect(Buffer.concat(chunks).toString()).toBe(expected);
    }

    const chunks: Buffer[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data));
    onData(Buffer.from("prefix"));
    onData(Buffer.from(`${noHookWarning}\n`));
    onData.end();
    expect(Buffer.concat(chunks).toString()).toBe(`prefix${noHookWarning}\n`);
  });

  test("preserves unresolved CR and split UTF-8 bytes exactly", () => {
    const raw = Buffer.from(`🙂 output\n${noHookWarning}\r`);
    for (let split = 1; split < Buffer.from("🙂").length; split += 1) {
      const chunks: Buffer[] = [];
      const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data));
      onData(raw.subarray(0, split));
      onData(raw.subarray(split));
      onData.end();
      expect(Buffer.concat(chunks)).toEqual(raw);
    }
  });

  test("marks rewritten exec input for one native filtering handoff", async () => {
    const { ctx, handler } = createRtkHarness();
    const input = { cmd: "git status" };
    await handler("tool_call")({ toolCallId: "filtered", toolName: "exec_command", input }, ctx);

    expect(consumeRtkExecInput(input)).toBe("git status");
    expect(consumeRtkExecInput(input)).toBeUndefined();
  });

  test("filters output from explicit RTK commands without rewriting them", async () => {
    const { ctx, exec, handler } = createRtkHarness();
    const input = { cmd: "rtk git status" };

    await handler("tool_call")({ toolCallId: "explicit", toolName: "exec_command", input }, ctx);

    expect(input.cmd).toBe("rtk git status");
    expect(exec).not.toHaveBeenCalled();
    expect(consumeRtkExecInput(input)).toBe("rtk git status");
  });
});

describe("RTK exec_command rewriting", () => {
  test("classifies skill reads from the original command before RTK rewriting", async () => {
    const { ctx, handler } = createRtkHarness();
    const input = { cmd: "cat a/SKILL.md" };
    await handler("tool_call")({ toolName: "exec_command", input }, ctx);
    const sessionExec = vi.fn(async (..._args: any[]) => ({
      chunk_id: "rtk-skill",
      wall_time_seconds: 0,
      exit_code: 0,
      output: "skill",
    }));

    await createExecCommandTool({ exec: sessionExec } as never).execute(
      "rtk-skill",
      input,
      undefined,
      undefined,
      { ...ctx, cwd: "/repo", isProjectTrusted: () => true } as never,
    );

    expect(input.cmd).toBe("rtk cat a/SKILL.md");
    expect(sessionExec.mock.calls[0]![0]).toMatchObject({
      cmd: "rtk cat a/SKILL.md",
      displayCommand: "cat a/SKILL.md",
    });
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith("[skill] a", "info"));
  });

  test("does not dereference stale contexts after async work", async () => {
    const resolvers = new Map<string, (result: any) => void>();
    const exec = vi.fn(
      async (_command: string, args: string[]) =>
        new Promise<any>((resolve) => resolvers.set(args[0]!, resolve)),
    );
    const { ctx, handler } = createRtkHarness(exec);
    const ui = ctx.ui;
    const input = { cmd: "git status" };
    const sessionStart = handler("session_start")({}, ctx);
    const toolCall = handler("tool_call")({ toolName: "exec_command", input }, ctx);

    for (const key of ["hasUI", "ui", "signal"])
      Object.defineProperty(ctx, key, {
        configurable: true,
        get: () => {
          throw new Error("stale extension context");
        },
      });
    resolvers.get("--version")!({ code: 0, killed: false, stdout: "rtk 1.0" });
    resolvers.get("rewrite")!({ code: 0, killed: false, stdout: "rtk git status" });

    await expect(Promise.all([sessionStart, toolCall])).resolves.toEqual([undefined, undefined]);
    expect(input.cmd).toBe("rtk git status");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("RTK rewrite"), "info");
  });

  test("warns once when RTK is missing and leaves later commands unchanged", async () => {
    const missingExec = vi.fn(async () => ({ code: 127, killed: false, stdout: "" }));
    const { ctx, handler } = createRtkHarness(missingExec);

    await handler("session_start")({}, ctx);
    await handler("session_start")({}, ctx);
    const input = { cmd: "git status", future: true };
    await handler("tool_call")({ toolCallId: "missing", toolName: "exec_command", input }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("binary not found"),
      "warning",
    );
    expect(input).toEqual({ cmd: "git status", future: true });
    expect(missingExec).toHaveBeenCalledTimes(2);
  });

  test("rewrites only cmd after earlier authorization and preserves every other field", async () => {
    const { ctx, exec, handler } = createRtkHarness();
    const input = {
      cmd: "git status",
      workdir: "/repo",
      shell: "zsh",
      tty: true,
      yield_time_ms: 25,
      max_output_tokens: 50,
      login: false,
      future: { preserved: true },
    };
    const originalFields = { ...input, cmd: undefined };
    const authorized = vi.fn(() => expect(input.cmd).toBe("git status"));

    authorized();
    await handler("tool_call")({ toolCallId: "rewrite", toolName: "exec_command", input }, ctx);

    expect(authorized).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith("rtk", ["rewrite", "git status"], {
      timeout: 2_000,
      signal: ctx.signal,
    });
    expect(input.cmd).toBe("rtk git status");
    expect({ ...input, cmd: undefined }).toEqual(originalFields);
  });

  test("passes through disabled, recursive, and failed rewrites", async () => {
    const failedExec = vi.fn(async () => ({ code: 1, killed: false, stdout: "ignored" }));
    const { ctx, handler } = createRtkHarness(failedExec);
    const failed = { cmd: "git status", untouched: true };
    await handler("tool_call")({ toolName: "exec_command", input: failed }, ctx);
    expect(failed).toEqual({ cmd: "git status", untouched: true });

    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "rtk git status" } }, ctx);
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "  rtk status" } }, ctx);
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "rtk&&echo nope" } }, ctx);
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "rtk; echo nope" } }, ctx);
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "'rtk' status" } }, ctx);
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: '"rtk" status' } }, ctx);
    process.env.RTK_DISABLED = "1";
    await handler("tool_call")({ toolName: "exec_command", input: { cmd: "ls" } }, ctx);
    expect(failedExec).toHaveBeenCalledOnce();
  });

  test("passes through a bounded rewrite timeout without changing the command", async () => {
    const timedOutExec = vi.fn(async () => ({ code: 1, killed: true, stdout: "" }));
    const { ctx, handler } = createRtkHarness(timedOutExec);
    const input = { cmd: "git status", future: true };

    await expect(
      handler("tool_call")({ toolCallId: "timed-out", toolName: "exec_command", input }, ctx),
    ).resolves.toBeUndefined();
    expect(input).toEqual({ cmd: "git status", future: true });
    expect(timedOutExec).toHaveBeenCalledWith("rtk", ["rewrite", "git status"], {
      timeout: 2_000,
      signal: ctx.signal,
    });
  });

  test("blocks native execution when the rewrite is cancelled", async () => {
    const controller = new AbortController();
    const exec = vi.fn(async () => {
      controller.abort();
      return { code: 0, killed: true, stdout: "" };
    });
    const harness = createRtkHarness(exec);
    harness.ctx.signal = controller.signal;
    const input = { cmd: "sleep 10" };

    await expect(
      harness.handler("tool_call")({ toolName: "exec_command", input }, harness.ctx),
    ).resolves.toEqual({ block: true, reason: "RTK rewrite cancelled." });
    expect(input.cmd).toBe("sleep 10");
  });

  test("keeps concurrent rewrites independent", async () => {
    const { ctx, handler } = createRtkHarness();
    const first = { cmd: "echo first" };
    const second = { cmd: "echo second", tty: true };

    await Promise.all([
      handler("tool_call")({ toolName: "exec_command", input: first }, ctx),
      handler("tool_call")({ toolName: "exec_command", input: second }, ctx),
    ]);
    expect(first.cmd).toBe("rtk echo first");
    expect(second).toEqual({ cmd: "rtk echo second", tty: true });
  });
});

test("keeps assistant bash rewriting unchanged", async () => {
  const { ctx, handler } = createRtkHarness();
  const input = { command: "git status", timeout: 10 };

  await handler("tool_call")({ toolName: "bash", input }, ctx);

  expect(input).toEqual({ command: "rtk git status", timeout: 10 });
});

describe("RTK user shell rewriting", () => {
  test("keeps the existing user_bash rewrite and execution path", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      killed: false,
      stdout: args[0] === "rewrite" ? "printf rewritten" : "rtk 1.0",
    }));
    const { ctx, handler } = createRtkHarness(exec);
    const override = await handler("user_bash")({ excludeFromContext: false }, ctx);
    const chunks: Buffer[] = [];

    await override.operations.exec("printf original", process.cwd(), {
      onData: (data: Buffer) => chunks.push(data),
    });

    expect(exec).toHaveBeenCalledWith("rtk", ["rewrite", "printf original"], {
      timeout: 2_000,
      signal: undefined,
    });
    expect(Buffer.concat(chunks).toString()).toBe("rewritten");
    await expect(handler("user_bash")({ excludeFromContext: true }, ctx)).resolves.toBeUndefined();
  });
});

describe("bash gate and RTK integration", () => {
  function createIntegratedHarness(choice: "Allow" | "Deny") {
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const emit = vi.fn();
    const nativeExec = vi.fn();
    const exec = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      killed: false,
      stdout: `rtk ${args[1]}`,
    }));
    const pi = {
      exec,
      registerFlag: vi.fn(),
      registerShortcut: vi.fn(),
      getFlag: vi.fn(() => false),
      appendEntry: vi.fn(),
      events: { emit, on: vi.fn(() => () => undefined) },
      on: vi.fn((name: string, handler: (event: any, ctx: any) => any) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      }),
    };
    registerBashGate(
      pi as any,
      { current: { bashGate: { rules: [{ cmd: "deploy", reason: "protected" }] } } },
      undefined,
    );
    registerRtk(pi as any);
    const ctx = {
      cwd: "/repo",
      signal: new AbortController().signal,
      hasUI: true,
      ui: {
        input: vi.fn(),
        notify: vi.fn(),
        select: vi.fn(async () => choice),
        setStatus: vi.fn(),
      },
      sessionManager: { getEntries: () => [] },
    };
    for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    return {
      emit,
      exec,
      nativeExec,
      async run(event: any) {
        for (const handler of handlers.get("tool_call") ?? []) {
          const result = await handler(event, ctx);
          if (result?.block) return result;
        }
        nativeExec(event.input.cmd);
        return undefined;
      },
    };
  }

  test("authorizes the original command and never rewrites a denied call", async () => {
    const denied = createIntegratedHarness("Deny");
    const deniedInput = { cmd: "deploy production", future: "preserved" };
    await expect(
      denied.run({ toolCallId: "denied", toolName: "exec_command", input: deniedInput }),
    ).resolves.toMatchObject({ block: true });
    expect(deniedInput).toEqual({ cmd: "deploy production", future: "preserved" });
    expect(denied.exec).toHaveBeenCalledTimes(1);
    expect(denied.nativeExec).not.toHaveBeenCalled();

    const allowed = createIntegratedHarness("Allow");
    const allowedInput = { cmd: "deploy production", future: "preserved" };
    await allowed.run({
      toolCallId: "allowed",
      toolName: "exec_command",
      input: allowedInput,
    });
    expect(allowed.emit).toHaveBeenCalledWith(
      "bites:bash_gate",
      expect.objectContaining({ command: "deploy production", toolName: "exec_command" }),
    );
    expect(allowedInput).toEqual({ cmd: "rtk deploy production", future: "preserved" });
    expect(allowed.nativeExec).toHaveBeenCalledWith("rtk deploy production");
  });
});
