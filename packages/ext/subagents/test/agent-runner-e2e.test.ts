/** End-to-end coverage against a real pi session and the embedded extension. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSubagentApprovalRequest } from "../../bash-gate/events.js";
import { createSubagentEventBus } from "../subagent-event-bus.js";
import { openAgentSession } from "../agent-runner.js";
import { shutdownAgentSession } from "../agent-session-shutdown.js";

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
  const sessions: Awaited<ReturnType<typeof openAgentSession>>[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await shutdownAgentSession(session);
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function runGeneral(
    options: {
      pi?: ReturnType<typeof makePi>;
      capture?: (session: any) => void;
      isolated?: boolean;
    } = {},
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
    const session = await openAgentSession(ctx, "worker", {
      pi: options.pi ?? makePi(),
      isolated: options.isolated,
      agentId: "e2e-agent",
      model,
      onSessionCreated: (session) => {
        active = session.getActiveToolNames();
        options.capture?.(session);
      },
    });
    sessions.push(session);
    return active;
  }

  it.each([false, true])(
    "constructs a raw child (isolated=%s) without collaboration tools",
    async (isolated) => {
      let session: any;
      const active = await runGeneral({ isolated, capture: (created) => (session = created) });

      expect(active).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
      expect(active).not.toContain("spawn_agent");
      expect(active).not.toContain("wait_agent");
      for (const name of ["send_input", "close_agent", "resume_agent", "MessageAgent"]) {
        expect(active).not.toContain(name);
        expect(session.getToolDefinition(name)).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "routes a real child bash gate through the root broker (grandchild=%s)",
    async (grandchild) => {
      const pi = makePi();
      const approve = vi.fn(async () => ({
        outcome: "allow" as const,
        authorization: "human-approved" as const,
      }));
      const unsubscribe = onSubagentApprovalRequest(pi, approve);
      let session: any;

      try {
        const parentPi = grandchild ? { ...pi, events: createSubagentEventBus(pi.events) } : pi;
        await runGeneral({ pi: parentPi, capture: (created) => (session = created) });
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
    },
  );
});
