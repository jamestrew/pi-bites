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
  });
});

describe("subagentBashGatePolicy", () => {
  test("reads prompt policy and fails invalid or missing policy closed", () => {
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
    expect(subagentBashGatePolicy([entry(metadata)])).toBe("deny");
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

function createBashGateHarness(entries: SessionEntry[] = []) {
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
    getFlag: vi.fn(() => false),
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
    notify: vi.fn(),
    select: vi.fn(async () => "Deny"),
    setStatus: vi.fn(),
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui,
    sessionManager: { getEntries: () => entries },
  };

  registerBashGate(pi as any, { current: {} });
  handlers.get("session_start")?.({}, ctx);

  return {
    pi,
    ctx,
    ui,
    eventHandlers,
    toggleYolo: () => shortcutHandler?.(ctx),
    toolCall: handlers.get("tool_call")!,
  };
}

describe("bash gate tool_call", () => {
  test("auto-denies gated bash for deny-policy subagents without prompting parent UI", async () => {
    const { pi, ui, toolCall, ctx } = createBashGateHarness([
      subagentEntry({ bashGatePolicy: "deny" }),
    ]);

    const result = await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(result).toEqual({
      block: true,
      reason: "Bash gate: gated command not allowed for this subagent.",
    });
    expect(ui.select).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("bites:bash_gate", expect.anything());
  });

  test("keeps main-agent gated bash on the approval path", async () => {
    const { pi, ui, toolCall, ctx } = createBashGateHarness();

    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(ui.select).toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("bites:bash_gate", {
      cwd: "/repo",
      command: "rm -rf tmp",
    });
    expect(pi.events.emit).toHaveBeenCalledWith("bites:bash_gate_resolved", {
      cwd: "/repo",
      command: "rm -rf tmp",
    });
  });

  test("shortcut toggles the main-agent gate and footer status", async () => {
    const { pi, ui, toggleYolo, toolCall, ctx } = createBashGateHarness();

    await toggleYolo();
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toBeUndefined();

    expect(pi.registerShortcut).toHaveBeenCalledWith(
      "ctrl+shift+y",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", "🔥 YOLO");
    expect(ui.select).not.toHaveBeenCalled();

    await toggleYolo();
    await toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    expect(ui.setStatus).toHaveBeenLastCalledWith("bash-gate-yolo", undefined);
    expect(ui.select).toHaveBeenCalled();
  });

  test("main-agent yolo mode does not bypass subagent gates", async () => {
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

    const result = await toolCall({ toolName: "bash", input: { command: "rg foo ." } }, ctx);

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
        decision: "allow",
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
        decision: "allow-session",
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
          decision: "allow-session",
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
        eventHandlers.get(`subagents:bash_gate:approval:reply:${raw.requestId}`)?.({ decision });
      });

      await expect(
        toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
      ).resolves.toEqual({
        block: true,
        reason: "Bash gate: subagent finished before approval.",
      });
    },
  );

  test("prompt-policy subagents deny when no broker answers", async () => {
    const { toolCall, ctx } = createBashGateHarness([
      subagentEntry({ agentId: "agent-1", title: "Explore", bashGatePolicy: "prompt" }),
    ]);

    await expect(
      toolCall({ toolName: "bash", input: { command: "rm -rf tmp" } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: "Bash gate: command was denied by parent approval.",
    });
  });
});

describe("findMatchedPattern", () => {
  test.each([
    "rg foo . 2>&1",
    "rg foo . 1>&2",
    "rg foo . 2>/dev/null",
    "rg foo . >/dev/null",
    "rg foo . >>/dev/null",
    "make build >/dev/null 2>&1",
    "python3 scripts/planner.py lisst --mode all | rg 'block-big-tables|sync-servers-code-refactor' -n -C 2",
    "printf '%s\n' code-refactor",
  ])("allows safe redirect case: %s", async (command: string) => {
    expect(await findMatchedPattern(command)).toBeUndefined();
  });

  test.each([
    ["echo hi > out.txt", "redirect:>"],
    ["cat < in.txt > out.txt", "redirect:>"],
    ["make build >/tmp/build.log 2>&1", "redirect:>"],
    ["echo hi >> out.txt", "redirect:>>"],
    ["rm -rf tmp", "rm"],
    ["git push origin main", "git push"],
    ["git branch -D old-branch", "git branch -d"],
    ["bun add zod", "bun add"],
    ["service nginx restart", "service restart"],
  ])("matches a destructive pattern for: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched).toBeDefined();
    expect(matched?.label).toBe(label);
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
