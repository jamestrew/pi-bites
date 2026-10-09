import { describe, expect, test, vi } from "vitest";
import { requestCommandApproval } from "./approval.js";

function approvalOptions() {
  const pi = { events: { emit: vi.fn(), on: vi.fn(() => () => {}) } };
  const ui = { select: vi.fn(async () => "Deny" as string | undefined), notify: vi.fn() };
  const allowances = new Set<string>();
  return {
    pi,
    ui,
    hasUI: true,
    cwd: "/repo",
    command: "rm build.txt",
    toolName: "bash" as const,
    signal: new AbortController().signal,
    prompt: "Approve removal?",
    sessionAllowKey: "rm",
    isAllowed: () => allowances.has("rm"),
    rememberAllowance: () => {
      allowances.add("rm");
    },
  };
}

describe("command approval workflow", () => {
  test.each(["manual", "automode"])(
    "a queued %s dialog rechecks ownership before becoming visible",
    async (mode) => {
      const options = approvalOptions();
      const displayed = Promise.withResolvers<void>();
      const choice = Promise.withResolvers<string>();
      options.ui.select.mockImplementationOnce(() => {
        displayed.resolve();
        return choice.promise;
      });
      const first = requestCommandApproval(options);
      await displayed.promise;
      let current = true;
      const second = requestCommandApproval({
        ...options,
        checkCurrent: () => {
          if (!current) throw new Error("owner replaced");
        },
        ...(mode === "automode" ? { review: async () => ({ outcome: "deny" as const }) } : {}),
      });
      // Let an independent review finish and enqueue its escalation behind the first dialog.
      await new Promise<void>((resolve) => setImmediate(resolve));
      current = false;
      choice.resolve("Deny");
      await first;
      await expect(second).resolves.toEqual({ outcome: "failure", message: "owner replaced" });
      expect(options.ui.select.mock.calls).toHaveLength(1);
      expect(options.pi.events.emit.mock.calls.map(([name]) => name)).toEqual([
        "bites:bash_gate",
        "bites:bash_gate_resolved",
      ]);
    },
  );
  test("adapters can retain their failure wording without owning error decisions", async () => {
    const options = approvalOptions();
    options.ui.select.mockRejectedValue(new Error("UI unavailable"));
    await expect(
      requestCommandApproval({
        ...options,
        failureMessage: (message, phase) => `${phase} failed closed: ${message}`,
      }),
    ).resolves.toEqual({ outcome: "failure", message: "manual failed closed: UI unavailable" });
    expect(options.pi.events.emit.mock.calls.map(([name]) => name)).toEqual([
      "bites:bash_gate",
      "bites:bash_gate_resolved",
    ]);
  });
  test("viewing a conversation returns to the manual decision without granting permission", async () => {
    const options = approvalOptions();
    options.ui.select.mockResolvedValueOnce("View conversation").mockResolvedValueOnce("Allow");
    let viewed = false;
    await expect(
      requestCommandApproval({
        ...options,
        getConversation: () => async () => {
          viewed = true;
        },
      }),
    ).resolves.toEqual({ outcome: "allow", authorization: "human-approved" });
    expect(viewed).toBe(true);
    expect(options.isAllowed()).toBe(false);
  });
  test("ownership invalidation during review cannot approve a replaced child", async () => {
    const options = approvalOptions();
    let current = true;
    await expect(
      requestCommandApproval({
        ...options,
        checkCurrent: () => {
          if (!current) throw new Error("parent approval session changed");
        },
        review: async () => {
          current = false;
          return { outcome: "allow" };
        },
      }),
    ).resolves.toEqual({ outcome: "failure", message: "parent approval session changed" });
    expect(options.isAllowed()).toBe(false);
  });
  test("a human may override an explicit review denial once", async () => {
    const options = approvalOptions();
    options.ui.select.mockResolvedValue("Allow once");
    await expect(
      requestCommandApproval({
        ...options,
        review: async () => ({ outcome: "deny", rationale: "too broad" }),
      }),
    ).resolves.toEqual({ outcome: "allow", authorization: "human-approved" });
    expect(options.isAllowed()).toBe(false);
  });
  test.each([true, false])("review failure stays closed with hasUI=%s", async (hasUI) => {
    const options = approvalOptions();
    options.ui.select.mockResolvedValue("Allow");
    await expect(
      requestCommandApproval({
        ...options,
        hasUI,
        review: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toEqual({ outcome: "failure", message: "Automode reviewer failed: offline" });
    expect(options.pi.events.emit.mock.calls).toEqual([]);
  });
  test("without UI an automated denial retains its rationale", async () => {
    const options = approvalOptions();
    await expect(
      requestCommandApproval({
        ...options,
        hasUI: false,
        review: async () => ({ outcome: "deny", rationale: "not authorized" }),
      }),
    ).resolves.toEqual({ outcome: "deny", source: "automode", rationale: "not authorized" });
    expect(options.pi.events.emit.mock.calls).toEqual([]);
  });

  test("escalation failure retains the original automated denial", async () => {
    const options = approvalOptions();
    options.ui.select.mockRejectedValue(new Error("UI unavailable"));
    await expect(
      requestCommandApproval({
        ...options,
        review: async () => ({ outcome: "deny", rationale: "not authorized" }),
      }),
    ).resolves.toEqual({ outcome: "deny", source: "automode", rationale: "not authorized" });
    expect(options.ui.notify.mock.calls).toEqual([
      ["Automode escalation failed closed: Error: UI unavailable", "error"],
    ]);
    expect(options.pi.events.emit.mock.calls.map(([name]) => name)).toEqual([
      "bites:bash_gate",
      "bites:bash_gate_resolved",
    ]);
  });

  test("a session allowance suppresses both a queued prompt and a later review", async () => {
    const options = approvalOptions();
    const displayed = Promise.withResolvers<void>();
    const choice = Promise.withResolvers<string>();
    options.ui.select.mockImplementationOnce(() => {
      displayed.resolve();
      return choice.promise;
    });
    const first = requestCommandApproval(options);
    await displayed.promise;
    const second = requestCommandApproval(options);
    choice.resolve('Allow for session ("rm")');
    const allowed = { outcome: "allow-session", authorization: "human-approved" };
    await expect(first).resolves.toEqual(allowed);
    await expect(second).resolves.toEqual(allowed);
    await expect(
      requestCommandApproval({
        ...options,
        review: async () => {
          throw new Error("must not review");
        },
      }),
    ).resolves.toEqual(allowed);
    expect(options.ui.select.mock.calls).toHaveLength(1);
  });

  test("cancellation settles a pending review and ignores its late allow", async () => {
    const options = approvalOptions();
    const cancellation = new AbortController();
    const decision = Promise.withResolvers<{ outcome: "allow" }>();
    const result = requestCommandApproval({
      ...options,
      signal: cancellation.signal,
      review: () => decision.promise,
    });
    cancellation.abort(new Error("cancelled"));
    await expect(result).resolves.toEqual({ outcome: "failure", message: "cancelled" });
    decision.resolve({ outcome: "allow" });
    await Promise.resolve();
    expect(options.isAllowed()).toBe(false);
    expect(options.pi.events.emit.mock.calls).toEqual([]);
  });

  test("replacing ownership during a manual choice cannot save an allowance", async () => {
    const options = approvalOptions();
    let current = true;
    options.ui.select.mockImplementationOnce(async () => {
      current = false;
      return 'Allow for session ("rm")';
    });
    await expect(
      requestCommandApproval({
        ...options,
        checkCurrent: () => {
          if (!current) throw new Error("owner replaced");
        },
      }),
    ).resolves.toEqual({ outcome: "failure", message: "owner replaced" });
    expect(options.isAllowed()).toBe(false);
    expect(options.pi.events.emit.mock.calls.map(([name]) => name)).toEqual([
      "bites:bash_gate",
      "bites:bash_gate_resolved",
    ]);
  });

  test("closing a conversation invalidates the subsequent manual decision", async () => {
    const options = approvalOptions();
    let current = true;
    options.ui.select.mockResolvedValueOnce("View conversation").mockResolvedValueOnce("Allow");
    await expect(
      requestCommandApproval({
        ...options,
        checkCurrent: () => {
          if (!current) throw new Error("owner replaced");
        },
        getConversation: () => async () => {
          current = false;
        },
      }),
    ).resolves.toEqual({ outcome: "failure", message: "owner replaced" });
    expect(options.ui.select.mock.calls).toHaveLength(1);
  });

  test.each(["Deny", undefined, "unknown selection"])(
    "manual choice %s fails closed",
    async (choice) => {
      const options = approvalOptions();
      options.ui.select.mockResolvedValue(choice);
      await expect(requestCommandApproval(options)).resolves.toEqual({
        outcome: "deny",
        source: "manual",
      });
      expect(options.isAllowed()).toBe(false);
    },
  );

  test("without UI a manual request is denied", async () => {
    const options = approvalOptions();
    await expect(requestCommandApproval({ ...options, hasUI: false })).resolves.toEqual({
      outcome: "deny",
      source: "manual",
    });
    expect(options.pi.events.emit.mock.calls).toEqual([]);
  });
  test("an automated allow needs neither UI nor a human allowance", async () => {
    const options = approvalOptions();
    await expect(
      requestCommandApproval({
        ...options,
        hasUI: false,
        review: async () => ({ outcome: "allow" as const }),
      }),
    ).resolves.toEqual({ outcome: "allow", authorization: "reviewer-approved" });
    expect(options.isAllowed()).toBe(false);
    expect(options.pi.events.emit.mock.calls).toEqual([]);
  });
  test("a human can approve one command without granting a session allowance", async () => {
    const options = approvalOptions();
    options.ui.select.mockResolvedValue("Allow");

    await expect(requestCommandApproval(options)).resolves.toEqual({
      outcome: "allow",
      authorization: "human-approved",
    });
    expect(options.isAllowed()).toBe(false);
    expect(options.pi.events.emit.mock.calls).toEqual([
      [
        "bites:bash_gate",
        expect.objectContaining({ requiresHuman: true, waitId: expect.any(String) }),
      ],
      [
        "bites:bash_gate_resolved",
        expect.objectContaining({ requiresHuman: true, waitId: expect.any(String) }),
      ],
    ]);
  });
});
