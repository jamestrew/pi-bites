import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { extractBashFacts } from "./bash-command-facts.js";
import registerBashGate, {
  findMatchedPattern,
  findMatchedPatterns,
  subagentBashGatePolicy,
} from "./index.js";

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
  autoMode?: Parameters<typeof registerBashGate>[2],
  hasUI = true,
) {
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
    appendEntry: vi.fn(),
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

  registerBashGate(pi as any, { current: {} }, autoMode);
  handlers.get("session_start")?.({}, ctx);

  return {
    pi,
    ctx,
    ui,
    eventHandlers,
    sessionStart: () => handlers.get("session_start")?.({}, ctx),
    toggleYolo: () => shortcutHandler?.(ctx),
    toolCall: handlers.get("tool_call")!,
  };
}

describe("bash gate tool_call", () => {
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
    const { toolCall, ctx, ui } = createBashGateHarness([], false, autoMode, false);

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm other.txt" } }, ctx),
    ).resolves.toEqual({ block: true, reason: "Automode review failed closed: timeout" });

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "rm build.txt", labels: ["rm"] }),
      ctx,
    );
    expect(ui.select).not.toHaveBeenCalled();
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
      ["Allow once", "Allow with reason…", "Export command", "Deny"],
    );
  });

  test("allows an automode-denied main-agent command once without recording history", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "too broad" });
    const { toolCall, ctx, ui, pi } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    ui.select.mockResolvedValue("Allow once");

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();

    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  test("allows with a non-empty reason and records trusted session history", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    const { toolCall, ctx, ui, pi } = createBashGateHarness([], false, {
      isEnabled: () => true,
      review,
    });
    ui.select.mockResolvedValue("Allow with reason…");
    ui.input.mockResolvedValueOnce("   ").mockResolvedValueOnce("Generated test output");

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, ctx),
    ).resolves.toBeUndefined();

    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(pi.appendEntry).toHaveBeenCalledWith("pi-bites:automode-override", {
      version: 1,
      command: "rm build.txt",
      reason: "Generated test output",
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
    const { toolCall, ctx } = createBashGateHarness([], false, {
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
  });

  test("--yolo bypasses automode review", async () => {
    const review = vi.fn().mockResolvedValue({ outcome: "deny" });
    const { toolCall, ctx } = createBashGateHarness(
      [],
      true,
      { isEnabled: () => true, review },
      false,
    );

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();
    expect(review).not.toHaveBeenCalled();
  });

  test("an existing session allowance bypasses later automode review", async () => {
    let enabled = false;
    const review = vi.fn().mockResolvedValue({ outcome: "deny" });
    const { toolCall, ctx, ui } = createBashGateHarness([], false, {
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

  test("shortcut toggles the main-agent gate and footer status", async () => {
    const { pi, ui, toggleYolo, toolCall, ctx } = createBashGateHarness();

    await toggleYolo();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();

    expect(pi.registerShortcut).toHaveBeenCalledWith(
      "alt+y",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", "🔥 YOLO");
    expect(ui.select).not.toHaveBeenCalled();

    await toggleYolo();
    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

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

  test("prompt-policy subagents use parent broker and allow once only", async () => {
    const { pi, toolCall, ctx, eventHandlers } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);
    let approvals = 0;
    eventHandlers.set("subagents:bash_gate:approval", (raw: any) => {
      approvals++;
      eventHandlers.get(`subagents:bash_gate:approval:ack:${raw.requestId}`)?.({});
      eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({
        result: { outcome: "allow" },
      });
    });

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();

    expect(approvals).toBe(2);
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:bash_gate:approval",
      expect.objectContaining({ title: "Explore", command: "rm -rf tmp", labels: ["rm"] }),
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
        result: { outcome: "allow-session" },
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
          result: { outcome: "allow-session" },
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
          result: { outcome: decision },
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

describe("findMatchedPattern", () => {
  test.each([
    "cat README.md 2>&1",
    "cat README.md 1>&2",
    "cat README.md 2>/dev/null",
    "cat README.md >/dev/null",
    "cat README.md >>/dev/null",
    "printf build 2>/dev/null | wc -c",
    "printf '%s\n' code-refactor",
    "grep -R needle packages",
    "rg needle .",
    "find packages -name '*.ts' -print",
    "tree packages",
    "aws sts get-caller-identity",
    "cargo test",
    "docker ps",
    "dotnet test",
    "ecs check",
    "glab mr view 42",
    "go test ./...",
    "golangci-lint run",
    "gradlew test",
    "gt log",
    "jest --runInBand",
    "kubectl get pods",
    "mvn test",
    "mypy packages",
    "next build",
    "npm test",
    "oc get pods",
    "paratest",
    "pest",
    "php -l index.php",
    "phpstan analyse",
    "phpunit",
    "pint --test",
    "pip list",
    "playwright test",
    "pnpm test",
    "prettier --check .",
    "prisma validate",
    "pytest -q",
    "rake test",
    "rspec",
    "rubocop",
    "ruff check .",
    "sbt test",
    "tsc --noEmit",
    "uv tree",
    "vitest run",
    "gh auth status",
    "gh issue list --repo owner/repo",
    "gh issue view 42",
    "gh pr checks 42",
    "gh pr diff 42",
    "gh pr view 42 --json title,state",
    "gh run list --limit 10",
    "gh workflow view ci.yml",
    "git add packages/ext/bash-gate/index.ts",
    "git commit -m 'relax bash gate'",
    "git diff --stat",
    "git log -5 --oneline",
    "git pull --rebase",
    "git rebase main",
    "git status --short --branch",
    "jj status",
    "jj st",
    "jj log -r @",
    "jj diff --summary",
    "jj bookmark list",
    "jj b list",
    "jj operation show",
    "jj op log",
    "jj file show README.md",
    "jj file track new-file.ts",
    "jj file untrack generated.txt",
    "jj git fetch",
    "jj new main",
    "jj commit -m 'relax bash gate'",
    "jj describe -m 'relax bash gate'",
    "jj edit @-",
    "jj rebase -d main",
    "jj restore README.md",
    "jj split packages/ext/bash-gate/index.ts",
    "jj squash",
    "jj abandon @",
    "jj workspace list",
  ])("allows allowlisted command: %s", async (command: string) => {
    expect(await findMatchedPattern(command)).toBeUndefined();
  });

  test.each([
    ["echo hi > out.txt", "redirect:>"],
    ["cat < in.txt > out.txt", "redirect:>"],
    ["make build >/tmp/build.log 2>&1", "redirect:>"],
    ["echo hi >> out.txt", "redirect:>>"],
    ["rm -rf tmp", "rm"],
    ["find . -delete", "find -delete"],
    ["find . -exec rm {} +", "find -exec"],
    ["find . -fprint matches.txt", "find -fprint"],
    ["rg --pre cat needle .", "rg --pre"],
    ["rg --pre=cat needle .", "rg --pre"],
    ["rg --hostname-bin=./script needle .", "rg --hostname-bin"],
    ["printf -v PATH .", "printf -v"],
    ["printf -vPATH .", "printf -v"],
    ["printf -v PATH .; cat README.md", "printf -v"],
    ["sort -o result.txt README.md", "sort -o"],
    ["sort --output=result.txt README.md", "sort --output"],
    ["sort --compress-program=./evil README.md", "sort --compress-program"],
    ["file -C -m magic", "file -c"],
    ["go env -w GOTOOLCHAIN=local", "go env"],
    ["mypy --install-types", "mypy --install-types"],
    ["pytest --basetemp=/tmp/pytest", "pytest --basetemp"],
    ["tree -o listing.txt", "tree -o"],
    ["ssh prod 'rm -rf /data'", "ssh"],
    ["scp artifact.tar prod:/srv", "scp"],
    ["sftp prod", "sftp"],
    ["git push origin main", "git push"],
    ["git branch -D old-branch", "git branch -d"],
    ["git rebase --exec 'rm -rf tmp' main", "git rebase"],
    ["git rebase -x'rm -rf tmp' main", "git rebase"],
    ["bun add zod", "bun add"],
    ["service nginx restart", "service restart"],
  ])("matches a destructive pattern for: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched).toBeDefined();
    expect(matched?.label).toBe(label);
  });

  test.each([
    ["aws s3 rm s3://bucket/key", "unlisted: aws s3 rm s3://bucket/key"],
    ["cargo publish", "unlisted: cargo publish"],
    ["docker rm app", "unlisted: docker rm app"],
    ["glab mr merge 42", "unlisted: glab mr merge 42"],
    ["go install example.com/tool@latest", "unlisted: go install example.com/tool@latest"],
    ["kubectl delete pod app", "unlisted: kubectl delete pod app"],
    ["npm run deploy", "unlisted: npm run deploy"],
    ["playwright install", "unlisted: playwright install"],
    ["prisma migrate deploy", "unlisted: prisma migrate deploy"],
    [
      "python3 -c 'import shutil; shutil.rmtree(\"tmp\")'",
      "unlisted: python3 -c 'import shutil; shutil.rmtree(\"tmp\")'",
    ],
    ["./cat README.md", "unlisted: ./cat README.md"],
    ["PATH=. cat README.md", "unlisted: PATH=. cat README.md"],
    ["CAT README.md", "unlisted: CAT README.md"],
    ["gh issue close 42", "unlisted: gh issue close 42"],
    ["gh pr merge 42", "unlisted: gh pr merge 42"],
    [
      "gh api --method DELETE repos/o/r/issues/1",
      "unlisted: gh api --method DELETE repos/o/r/issues/1",
    ],
    ["jj bookmark delete old", "unlisted: jj bookmark delete old"],
    ["jj operation restore abc", "unlisted: jj operation restore abc"],
    ["jj file chmod +x script", "unlisted: jj file chmod +x script"],
  ])("gates commands outside the allowlist: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched?.label).toBe(label);
    expect(matched?.source).toBe("builtin");
    expect(matched?.reason).toContain("not on the bash-gate allowlist");
  });

  test("matches every gated command in a compound command", async () => {
    const matches = await findMatchedPatterns("chmod +x foo && rm bar");

    expect(matches.map((match) => match.label)).toEqual(expect.arrayContaining(["chmod", "rm"]));
  });

  test("matches every gated command separated by semicolons", async () => {
    const matches = await findMatchedPatterns("rmdir a; rm b");

    expect(matches.map((match) => match.label)).toEqual(["rmdir", "rm"]);
  });

  test("supports configured command-only rules", async () => {
    const matched = await findMatchedPattern("pytest -q", {
      bashGate: { rules: [{ cmd: "pytest" }] },
    });

    expect(matched?.label).toBe("pytest");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured subcommand rules", async () => {
    const matched = await findMatchedPattern("git push origin main", {
      bashGate: {
        rules: [{ cmd: "git", subcommands: ["push"], reason: "push mutates remote state" }],
      },
    });

    expect(matched?.label).toBe("git push");
    expect(matched?.reason).toBe("push mutates remote state");
  });

  test("supports configured flagAny rules", async () => {
    const matched = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(matched?.label).toBe("sed -i");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured redirect rules", async () => {
    const matched = await findMatchedPattern("echo hi >> out.txt", {
      bashGate: { rules: [{ redirects: "append" }] },
    });

    expect(matched?.label).toBe("redirect:>>");
    expect(matched?.source).toBe("configured");
  });

  test("configured rules extend builtin defaults", async () => {
    const builtinMatch = await findMatchedPattern("git push origin main", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });
    const configuredMatch = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(builtinMatch?.label).toBe("git push");
    expect(builtinMatch?.source).toBe("builtin");
    expect(configuredMatch?.label).toBe("sed -i");
    expect(configuredMatch?.source).toBe("configured");
  });
});
