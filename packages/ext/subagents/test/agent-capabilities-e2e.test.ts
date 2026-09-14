/** Ref #306: a parent's Code Mode projection is not its delegation permission set. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createEventBus, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdapterToolState,
  getDelegationTools,
  NESTED_TOOLS,
  reconcileTools,
} from "../../codex-adapter/activation.js";
import { openAgentSession } from "../agent-runner.js";
import { shutdownAgentSession } from "../agent-session-shutdown.js";

vi.setConfig({ testTimeout: 30_000 });

const CORE = ["read", "bash", "edit", "write"];
const INITIAL = [...CORE, ...NESTED_TOOLS, "exec", "wait"];

describe("delegated Code Mode capabilities (real embedded child)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let child: AgentSession | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "agent-capabilities-e2e-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [
        { id: "gpt-6", contextWindow: 200_000 },
        { id: "faux-1", contextWindow: 200_000 },
      ],
    });
  });

  afterEach(async () => {
    try {
      if (child) await shutdownAgentSession(child);
    } finally {
      child = undefined;
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { modelId: "gpt-6", omitted: [] },
    { modelId: "faux-1", omitted: [] },
    { modelId: "gpt-6", omitted: ["edit", "write"] },
    { modelId: "faux-1", omitted: ["edit", "write"] },
    { modelId: "gpt-6", omitted: ["apply_patch"] },
    { modelId: "faux-1", omitted: ["apply_patch"] },
  ])("initializes $modelId with parent restrictions $omitted", async ({ modelId, omitted }) => {
    const initial = INITIAL.filter((name) => !omitted.includes(name));
    const state = createAdapterToolState();
    const projected = reconcileTools(initial, true, state);
    expect(projected).toContain("exec");
    expect(projected).toContain("wait");
    expect(projected).not.toContain("read");
    expect(projected).not.toContain("bash");

    const allowedTools = getDelegationTools(projected, state);
    const parentModel = faux.getModel("gpt-6")!;
    const childModel = faux.getModel(modelId)!;
    const onToolActivity = vi.fn();
    child = await openAgentSession(
      {
        cwd,
        sessionId: "parent",
        systemPrompt: "PARENT",
        model: parentModel,
        availableModels: [parentModel, faux.getModel("faux-1")!],
        providers: [],
      },
      "worker",
      {
        pi: {
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          events: createEventBus(),
        } as unknown as Parameters<typeof openAgentSession>[2]["pi"],
        agentId: "capabilities-e2e",
        model: childModel,
        allowedTools,
        onToolActivity,
      },
    );

    expect(onToolActivity).not.toHaveBeenCalled();
    expect(child.model?.id).toBe(modelId);
    expect(child.messages).toEqual([]); // Initialization only: no prompt or provider request.
    const active = child.getActiveToolNames();
    expect(active).not.toContain("MessageAgent");
    expect(active).not.toContain("spawn_agent");
    expect(active).not.toContain("wait_agent");
    for (const name of omitted) {
      expect(allowedTools).not.toContain(name);
      expect(active).not.toContain(name);
    }

    if (modelId === "gpt-6") {
      expect(active).toEqual(expect.arrayContaining(["exec", "wait"]));
      expect(active).not.toContain("bash");
      const description = child.getToolDefinition("exec")!.description;
      // These are the live, session_start-refreshed nested declarations, not just
      // registered tool names (which exist even when the bridge disables them).
      // web_run also requires provider credentials, intentionally absent here.
      for (const name of ["exec_command", "write_stdin", "view_image"])
        expect(description).toContain(name);
      if (omitted.length === 0) expect(description).toContain("apply_patch");
      else expect(description).not.toContain("apply_patch");
      if (omitted.includes("apply_patch"))
        expect(active).toEqual(expect.arrayContaining(["edit", "write"]));
    } else {
      expect(active).toEqual(
        expect.arrayContaining(CORE.filter((name) => !omitted.includes(name))),
      );
      expect(active).not.toContain("exec");
      expect(active).not.toContain("wait");
      for (const name of NESTED_TOOLS) expect(active).not.toContain(name);
    }
  });
});
