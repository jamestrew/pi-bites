/** End-to-end coverage against a real pi session and the embedded extension. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSubagentApprovalRequest } from "../../bash-gate/events.js";
import { runAgent } from "../agent-runner.js";

vi.setConfig({ testTimeout: 30_000 });

function makePi() {
  return {
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    events: createEventBus(),
  } as any;
}

describe("embedded agent runner (real pi session)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });

  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function runGeneral(
    options: { pi?: ReturnType<typeof makePi>; capture?: (session: any) => void } = {},
  ): Promise<string[]> {
    const model = faux.getModel();
    const ctx: any = {
      cwd,
      getSystemPrompt: () => "PARENT",
      model,
      modelRegistry: {
        find: () => model,
        getAll: () => [model],
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
        getRegisteredProviderIds: () => [],
        getRegisteredProviderConfig: () => undefined,
        registerProvider: () => {},
        unregisterProvider: () => {},
      },
      sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
    };

    let active: string[] = [];
    try {
      await runAgent(ctx, "general", "go", {
        pi: options.pi ?? makePi(),
        messageParent: () => false,
        agentId: "e2e-agent",
        model,
        onSessionCreated: (session) => {
          active = session.getActiveToolNames();
          options.capture?.(session);
        },
      });
    } catch {
      // The active tool set is fixed before the intentionally unconfigured prompt turn.
    }
    return active;
  }

  it("constructs the real child with the embedded general tools and only MessageAgent", async () => {
    let session: any;
    const active = await runGeneral({ capture: (created) => (session = created) });

    expect(active).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write", "MessageAgent"]),
    );
    expect(active).not.toContain("Agent");
    expect(active).not.toContain("WaitAgent");
    const definition = session.getToolDefinition("MessageAgent");
    expect(definition.parameters.required).toEqual(["message"]);
    expect(Object.keys(definition.parameters.properties)).toEqual(["message"]);
    expect(definition.parameters.additionalProperties).toBe(false);
  });

  it("routes a real child bash gate to the parent approval broker", async () => {
    const pi = makePi();
    const approve = vi.fn(async () => ({
      outcome: "allow" as const,
      authorization: "human-approved" as const,
    }));
    const unsubscribe = onSubagentApprovalRequest(pi, approve);
    let session: any;

    try {
      await runGeneral({ pi, capture: (created) => (session = created) });
      const result = await session._extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "gate-e2e",
        input: { command: "rm -rf tmp" },
      });

      expect(result).toBeUndefined();
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "e2e-agent", command: "rm -rf tmp" }),
      );
    } finally {
      unsubscribe();
    }
  });
});
