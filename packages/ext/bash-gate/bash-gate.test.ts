import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { extractBashFacts } from "./bash-command-facts.js";
import registerBashGate, { subagentBashGatePolicy } from "./index.js";

describe("extractBashFacts", () => {
  test("extracts commands, redirects, path-ish args, pipe presence, and flags", async () => {
    const facts = await extractBashFacts("git push origin main > out.txt | tee ./log.txt");

    expect(facts.hasPipe).toBe(true);
    expect(facts.commands.map((command) => command.argv)).toEqual([
      ["git", "push", "origin", "main"],
      ["tee", "./log.txt"],
    ]);
    expect(facts.commands[0]?.flags).toEqual([]);
    expect(facts.redirects).toContainEqual({ operator: ">", target: "out.txt" });
    expect(facts.pathCandidates).toContain("./log.txt");
    expect(facts.hasVariableAssignment).toBe(false);
  });

  test("detects environment assignments", async () => {
    expect((await extractBashFacts("PATH=. cat README.md")).hasVariableAssignment).toBe(true);
  });
});

describe("subagentBashGatePolicy", () => {
  test("defaults valid subagents to parent prompting and fails invalid metadata closed", () => {
    const entry = (data: unknown): SessionEntry => ({
      type: "custom",
      id: "id",
      parentId: null,
      timestamp: "now",
      customType: "pi-bites:subagent",
      data,
    });

    const metadata = { type: "Explore", title: "Explore" };
    expect(subagentBashGatePolicy([entry({ ...metadata, bashGatePolicy: "prompt" })])).toBe(
      "prompt",
    );
    expect(subagentBashGatePolicy([entry({ ...metadata, bashGatePolicy: "wat" })])).toBe("deny");
    expect(subagentBashGatePolicy([entry(metadata)])).toBe("prompt");
  });
});

function subagentEntry(data: Record<string, unknown>): SessionEntry {
  return {
    type: "custom",
    id: "id",
    parentId: null,
    timestamp: "now",
    customType: "pi-bites:subagent",
    data: { type: "Explore", title: "Explore", ...data },
  };
}

function createBashGateHarness(
  entries: SessionEntry[] = [],
  yolo = false,
  autoMode?: Omit<NonNullable<Parameters<typeof registerBashGate>[2]>, "setEnabled"> &
    Partial<Pick<NonNullable<Parameters<typeof registerBashGate>[2]>, "setEnabled">>,
  hasUI = true,
  config: Parameters<typeof registerBashGate>[1]["current"] = {},
) {
  let toolCallSequence = 0;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const emit = vi.fn((event: string, data: any) => {
    eventHandlers.get(event)?.(data);
  });
  let shortcutHandler: ((ctx: any) => unknown) | undefined;
  const pi = {
    registerFlag: vi.fn(),
    registerShortcut: vi.fn((_key: string, options: { handler: (ctx: any) => unknown }) => {
      shortcutHandler = options.handler;
    }),
    getFlag: vi.fn(() => yolo),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data } as SessionEntry),
    ),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    }),
    events: {
      emit,
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    },
  };
  const ui = {
    input: vi.fn(async () => undefined as string | undefined),
    notify: vi.fn(),
    select: vi.fn(async () => "Deny"),
    setStatus: vi.fn(),
  };
  const ctx = {
    cwd: "/repo",
    hasUI,
    ui,
    sessionManager: { getEntries: () => entries },
  };

  registerBashGate(
    pi as any,
    { current: config },
    autoMode && { setEnabled: vi.fn(), ...autoMode },
  );
  handlers.get("session_start")?.({}, ctx);

  return {
    pi,
    ctx,
    ui,
    eventHandlers,
    sessionStart: () => handlers.get("session_start")?.({}, ctx),
    sessionShutdown: () => handlers.get("session_shutdown")?.({}, ctx),
    toggleYolo: () => shortcutHandler?.(ctx),
    toolCall: (event: any, context: any) =>
      handlers.get("tool_call")!(
        { toolCallId: `tool-call-${++toolCallSequence}`, ...event },
        context,
      ),
  };
}

describe("bash gate tool_call", () => {
  test.each([
    ["bash", { command: "" }],
    ["exec_command", { cmd: "" }],
  ])("records an empty %s invocation as not-reviewed", async (toolName, input) => {
    const { toolCall, ctx, pi } = createBashGateHarness();

    await expect(toolCall({ toolName, input }, ctx)).resolves.toBeUndefined();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ command: "", status: "not-reviewed" }),
    );
  });

  test.each([
    ["bash", { command: "deploy production" }],
    ["exec_command", { cmd: "deploy production" }],
  ])("applies configured rules to the %s shell contract", async (toolName, input) => {
    const { toolCall, ctx, ui } = createBashGateHarness([], false, undefined, true, {
      bashGate: { rules: [{ cmd: "deploy", reason: "production deployment" }] },
    });

    await expect(toolCall({ toolName, input }, ctx)).resolves.toEqual({
      block: true,
      reason: "Bash gate: command was denied by the user.",
    });
    expect(ui.select).toHaveBeenCalledWith(expect.stringContaining("production deployment"), [
      "Allow",
      'Allow for session ("deploy")',
      "Deny",
    ]);
  });

  test("shares session allowances across shell tool contracts", async () => {
    const { toolCall, ctx, ui, pi } = createBashGateHarness();
    ui.select.mockResolvedValue('Allow for session ("rm")');

    await expect(
      toolCall({ toolName: "exec_command", input: { cmd: "rm first.txt" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm second.txt" } }, ctx),
    ).resolves.toBeUndefined();

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(
      pi.appendEntry.mock.calls.map(([, data]) => (data as { status: string }).status),
    ).toEqual(["human-approved", "human-approved"]);
  });

  test("allows exec_command once without remembering the decision", async () => {
    const { toolCall, ctx, ui } = createBashGateHarness();
    ui.select.mockResolvedValue("Allow");

    await toolCall({ toolName: "exec_command", input: { cmd: "rm first.txt" } }, ctx);
    await toolCall({ toolName: "exec_command", input: { cmd: "rm second.txt" } }, ctx);

    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  test("fails closed for gated exec_command calls without UI", async () => {
    const { toolCall, ctx } = createBashGateHarness([], false, undefined, false);

    await expect(
      toolCall({ toolName: "exec_command", input: { cmd: "rm build.txt" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: no UI available for confirmation.",
    });
  });

  test("records a failed manual approval prompt as blocked", async () => {
    const { toolCall, ctx, ui, pi } = createBashGateHarness();
    ui.select.mockRejectedValue(new Error("UI unavailable"));

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: approval failed closed: UI unavailable",
    });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ status: "blocked" }),
    );
  });

  test("sends exec_command's original cmd and tool contract through automode and lifecycle events", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const { toolCall, ctx, pi } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    await expect(
      toolCall(
        { toolName: "exec_command", input: { cmd: "rm original", command: "cat safe" } },
        ctx,
      ),
    ).resolves.toBeUndefined();

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "rm original", toolName: "exec_command" }),
      expect.anything(),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate",
      expect.objectContaining({ command: "rm original", toolName: "exec_command" }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({
        toolCallId: "tool-call-1",
        toolName: "exec_command",
        command: "rm original",
        status: "reviewer-approved",
      }),
    );
  });

  test("fails closed instead of persisting to a replacement session", async () => {
    let resolveReview!: (decision: { outcome: "allow" }) => void;
    const review = vi.fn(
      () => new Promise<{ outcome: "allow" }>((resolve) => (resolveReview = resolve)),
    );
    const { toolCall, ctx, pi, sessionShutdown } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });

    const pending = toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    sessionShutdown();
    resolveReview({ outcome: "allow" });

    await expect(pending).resolves.toEqual({
      block: true,
      reason: "Bash gate: owning session changed before authorization completed.",
    });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ status: "blocked" }),
    );
  });

  test("applies deny-policy subagent gates to exec_command", async () => {
    const { toolCall, ctx } = createBashGateHarness([subagentEntry({ bashGatePolicy: "deny" })]);

    await expect(
      toolCall({ toolName: "exec_command", input: { cmd: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: gated command not allowed for this subagent.",
    });
  });

  test("shows the footer status when started with --yolo", () => {
    const { ui } = createBashGateHarness([], true);

    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", "🔥 YOLO");
  });

  test("auto-denies gated bash for deny-policy subagents without reaching UI or automode", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const { pi, ui, toolCall, ctx } = createBashGateHarness(
      [subagentEntry({ bashGatePolicy: "deny" })],
      false,
      { isEnabled: () => true, review },
    );

    const result = await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(result).toEqual({
      block: true,
      reason: "Bash gate: gated command not allowed for this subagent.",
    });
    expect(review).not.toHaveBeenCalled();
    expect(ui.select).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("bites:bash_gate", expect.anything());
  });

  test("keeps main-agent gated bash on the approval path", async () => {
    const { pi, ui, toolCall, ctx } = createBashGateHarness();

    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(ui.select).toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate",
      expect.objectContaining({
        cwd: "/repo",
        command: "rm -rf tmp",
        requiresHuman: true,
        waitId: expect.any(String),
      }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate_resolved",
      expect.objectContaining({
        cwd: "/repo",
        command: "rm -rf tmp",
        requiresHuman: true,
        waitId: expect.any(String),
      }),
    );
  });

  test("routes no-UI gated commands through automode and fails closed on reviewer failure", async () => {
    const review = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "allow" })
      .mockRejectedValueOnce(new Error("timeout"));
    const autoMode = { isEnabled: () => true, review };
    const { toolCall, ctx, ui, pi } = createBashGateHarness([], false, autoMode, false);

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm other.txt" } }, ctx),
    ).resolves.toEqual({ block: true, reason: "Automode review failed closed: timeout" });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "rm build.txt", labels: ["rm"] }),
      expect.anything(),
    );
    expect(ui.select).not.toHaveBeenCalled();
    expect(
      pi.appendEntry.mock.calls.map(([, data]) => (data as { status: string }).status),
    ).toEqual(["reviewer-approved", "blocked"]);
  });

  test("escalates an explicit main-agent automode denial and preserves denial guidance", async () => {
    const review = vi.fn().mockResolvedValue({
      outcome: "deny",
      rationale: "removes files outside the requested build directory",
    });
    const { toolCall, ctx, ui } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason:
        "Automode denied this command: removes files outside the requested build directory Do not pursue the same outcome through a workaround; use a materially safer alternative or ask the user.",
    });
    expect(ui.select).toHaveBeenCalledWith(
      expect.stringContaining("removes files outside the requested build directory"),
      ["Allow once", "Export command", "Deny"],
    );
  });

  test("records an automode-denied command allowed by the human as human-approved", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "too broad" });
    const { toolCall, ctx, ui, pi } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    ui.select.mockResolvedValue("Allow once");

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();

    expect(pi.appendEntry).toHaveBeenCalledWith("pi-bites:shell-authorization", {
      version: 1,
      toolCallId: "tool-call-1",
      toolName: "bash",
      command: "rm build.txt",
      status: "human-approved",
    });
  });

  test("exports the exact denied command to a private non-executable file and stays blocked", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    const { toolCall, ctx, ui } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    ui.select.mockResolvedValue("Export command");

    const result = await toolCall(
      { toolName: "bash", input: { command: "rm 'file with spaces.txt'" } },
      ctx,
    );
    const path = ui.notify.mock.calls.find(
      ([message, level]) => level === "info" && typeof message === "string",
    )?.[0] as string;

    try {
      expect(result).toEqual(expect.objectContaining({ block: true }));
      expect(await readFile(path, "utf8")).toBe("rm 'file with spaces.txt'\n");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    } finally {
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  });

  test("keeps an automode denial fail-closed without UI", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    const { toolCall, ctx, ui } = createBashGateHarness(
      [],
      false,
      { isEnabled: () => true, review },
      false,
    );

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason:
        "Automode denied this command: not authorized Do not pursue the same outcome through a workaround; use a materially safer alternative or ask the user.",
    });
    expect(ui.select).not.toHaveBeenCalled();
  });

  test("does not offer escalation when the reviewer fails in an interactive session", async () => {
    const review = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { toolCall, ctx, ui } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Automode review failed closed: provider unavailable",
    });
    expect(ui.select).not.toHaveBeenCalled();
  });

  test("uses snapshotted UI and event data when ctx becomes stale during review", async () => {
    let stale = false;
    const review = vi.fn().mockImplementation(async () => {
      stale = true;
      return { outcome: "deny", rationale: "not authorized" };
    });
    const { toolCall, ctx, ui } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    ui.select.mockResolvedValue("Allow once");
    const values = {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      ui: ctx.ui,
      sessionManager: ctx.sessionManager,
    };
    for (const key of ["cwd", "hasUI", "ui", "sessionManager"] as const) {
      Object.defineProperty(ctx, key, {
        get: () => {
          if (stale) throw new Error("stale ctx");
          return values[key];
        },
      });
    }

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();
  });

  test("does not invoke automode until a bash command actually matches the gate", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const { toolCall, ctx, pi } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "cat README.md" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "read", input: { command: "rm file" } }, ctx),
    ).resolves.toBeUndefined();
    expect(review).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ command: "cat README.md", status: "not-reviewed" }),
    );
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  test("--yolo disables automode, bypasses review, and locks the shortcut", async () => {
    let enabled = true;
    const review = vi.fn().mockResolvedValue({ outcome: "deny" });
    const autoMode = {
      isEnabled: () => enabled,
      setEnabled: vi.fn((value: boolean) => (enabled = value)),
      review,
    };
    const { toolCall, ctx, toggleYolo, ui, pi } = createBashGateHarness([], true, autoMode, false);
    expect(enabled).toBe(false);
    await toggleYolo();
    expect(ui.notify).toHaveBeenCalledWith("Bash gate mode is fixed to YOLO by --yolo.", "info");
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();
    expect(review).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ status: "not-reviewed" }),
    );
  });

  test("configured yolo mode starts in YOLO without locking the shortcut", async () => {
    let enabled = true;
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const autoMode = {
      isEnabled: () => enabled,
      setEnabled: vi.fn((value: boolean) => (enabled = value)),
      review,
    };
    const { toolCall, ctx, toggleYolo, ui } = createBashGateHarness([], false, autoMode, true, {
      bashGate: { mode: "yolo" },
    });

    expect(enabled).toBe(false);
    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", "🔥 YOLO");
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();
    expect(review).not.toHaveBeenCalled();

    await toggleYolo();
    expect(enabled).toBe(true);
  });

  test("an existing session allowance bypasses later automode review", async () => {
    let enabled = false;
    const review = vi.fn().mockResolvedValue({ outcome: "deny" });
    const { toolCall, ctx, ui, pi } = createBashGateHarness([], false, {
      isEnabled: () => enabled,
      review,
    });
    ui.select.mockResolvedValue('Allow for session ("rm")');
    await toolCall({ toolName: "bash", input: { command: "rm first.txt" } }, ctx);
    enabled = true;
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm second.txt" } }, ctx),
    ).resolves.toBeUndefined();

    expect(review).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(
      pi.appendEntry.mock.calls.map(([, data]) => (data as { status: string }).status),
    ).toEqual(["human-approved", "human-approved"]);
  });

  test("scopes unlisted session allowances to the exact command", async () => {
    const { toolCall, ctx, ui } = createBashGateHarness();
    ui.select.mockResolvedValue('Allow for session ("unlisted")');

    await toolCall({ toolName: "bash", input: { command: "FOO=1 cat README.md" } }, ctx);
    await toolCall({ toolName: "bash", input: { command: "PATH=. cat README.md" } }, ctx);

    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  test("clears session allowances when the session is replaced", async () => {
    const { toolCall, ctx, ui, sessionStart } = createBashGateHarness();
    ui.select.mockResolvedValue('Allow for session ("rm")');

    await toolCall({ toolName: "bash", input: { command: "rm first.txt" } }, ctx);
    sessionStart();
    await toolCall({ toolName: "bash", input: { command: "rm second.txt" } }, ctx);

    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  test("shortcut cycles YOLO, Auto, and Bash gate modes", async () => {
    let autoEnabled = false;
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const autoMode = {
      isEnabled: () => autoEnabled,
      setEnabled: vi.fn((enabled: boolean) => (autoEnabled = enabled)),
      review,
    };
    const { ui, toggleYolo, toolCall, ctx } = createBashGateHarness([], false, autoMode);
    const gatedCall = () => toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);
    await toggleYolo();
    await expect(gatedCall()).resolves.toBeUndefined();
    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", "🔥 YOLO");
    expect(ui.select).not.toHaveBeenCalled();
    await toggleYolo();
    await expect(gatedCall()).resolves.toBeUndefined();
    expect(autoMode.setEnabled).toHaveBeenLastCalledWith(true, ctx);
    expect(review).toHaveBeenCalledTimes(1);
    expect(ui.select).not.toHaveBeenCalled();
    await toggleYolo();
    await gatedCall();
    expect(autoMode.setEnabled).toHaveBeenLastCalledWith(false, ctx);
    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", undefined);
    expect(ui.select).toHaveBeenCalled();
  });

  test("main-agent yolo mode does not bypass explicit deny-policy subagent gates", async () => {
    const { toggleYolo, toolCall, ctx } = createBashGateHarness([
      subagentEntry({ bashGatePolicy: "deny" }),
    ]);

    await toggleYolo();

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: gated command not allowed for this subagent.",
    });
  });

  test("does not gate safe bash for deny-policy subagents", async () => {
    const { pi, ui, toolCall, ctx } = createBashGateHarness([
      subagentEntry({ bashGatePolicy: "deny" }),
    ]);

    const result = await toolCall({ toolName: "bash", input: { command: "cat README.md" } }, ctx);

    expect(result).toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  test("prompt-policy subagents use parent broker for exec_command and allow once only", async () => {
    const { pi, toolCall, ctx, eventHandlers } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);
    let approvals = 0;
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      approvals++;
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "allow", authorization: "human-approved" },
      });
    });

    await expect(
      toolCall({ toolName: "exec_command", input: { cmd: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "exec_command", input: { cmd: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();

    expect(approvals).toBe(2);
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:bash_gate:approval",
      expect.objectContaining({
        title: "Explore",
        command: "rm -rf tmp",
        toolName: "exec_command",
        labels: ["rm"],
      }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate",
      expect.objectContaining({ command: "rm -rf tmp", requiresHuman: false }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate_resolved",
      expect.objectContaining({ command: "rm -rf tmp", requiresHuman: false }),
    );
  });

  test("prompt-policy allow for session is scoped to one subagent session", async () => {
    const entries = [
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ];
    const { toolCall, ctx, eventHandlers } = createBashGateHarness(entries);
    let approvals = 0;
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      approvals++;
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "allow-session", authorization: "human-approved" },
      });
    });

    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);
    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);
    entries[0] = subagentEntry({ agentId: "agent-2", title: "Explore", bashGatePolicy: "prompt" });
    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(approvals).toBe(2);
  });

  test.each(["subagents:completed", "subagents:failed"])(
    "clears scoped allowances on %s",
    async (lifecycleEvent) => {
      const entries = [
        subagentEntry({ agentId: "agent-1", title: "General", bashGatePolicy: "prompt" }),
      ];
      const { pi, toolCall, ctx, eventHandlers } = createBashGateHarness(entries);
      let approvals = 0;
      eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
        approvals++;
        eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
        eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
          result: { outcome: "allow-session", authorization: "human-approved" },
        });
      });

      await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);
      pi.events.emit(lifecycleEvent, { id: "agent-1" });
      await expect(
        toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
      ).resolves.toEqual({
        block: true,
        reason: "Bash gate: subagent identity is unavailable or finished.",
      });

      expect(approvals).toBe(1);
    },
  );

  test.each(["allow", "allow-session"])(
    "rejects %s resolved after subagent completion",
    async (decision) => {
      const entries = [
        subagentEntry({ agentId: "agent-1", title: "General", bashGatePolicy: "prompt" }),
      ];
      const { pi, toolCall, ctx, eventHandlers } = createBashGateHarness(entries);
      eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
        eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
        pi.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });
        eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
          result: {
            outcome: decision,
            authorization: "human-approved",
          },
        });
      });

      await expect(
        toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
      ).resolves.toEqual({
        block: true,
        reason: "Bash gate: subagent finished before approval.",
      });
    },
  );

  test("preserves automode denial rationale and anti-circumvention guidance", async () => {
    const { toolCall, ctx, eventHandlers } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "deny", source: "automode", rationale: "deletes user data" },
      });
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason:
        "Automode denied this command: deletes user data Do not pursue the same outcome through a workaround or indirect execution; use a materially safer alternative or ask the user.",
    });
  });

  test("distinguishes reviewer failure from an explicit denial", async () => {
    const { toolCall, ctx, eventHandlers } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "failure", message: "Automode reviewer failed: timeout" },
      });
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: parent approval failed closed: Automode reviewer failed: timeout",
    });
  });

  test("prompt-policy subagents fail closed on malformed parent replies", async () => {
    const { toolCall, ctx, eventHandlers } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "deny", source: "unknown" },
      });
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: parent approval failed closed: malformed parent approval reply",
    });
  });

  test("prompt-policy subagents fail closed when no broker answers", async () => {
    const { toolCall, ctx } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: parent approval failed closed: parent approval broker unavailable",
    });
  });
});
