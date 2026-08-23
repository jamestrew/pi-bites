import { describe, expect, test, vi } from "vitest";

vi.mock("./apply-patch/tool.js", () => ({
  registerApplyPatchTool: (pi: { registerTool(tool: { name: string }): void }) =>
    pi.registerTool({ name: "apply_patch" }),
}));
const { shutdown } = vi.hoisted(() => ({ shutdown: vi.fn(async () => {}) }));
vi.mock("./exec/session-manager.js", () => ({
  createExecSessionManager: () => ({ shutdown }),
}));
vi.mock("./exec/command-tool.js", () => ({
  registerExecCommandTool: (pi: { registerTool(tool: { name: string }): void }) =>
    pi.registerTool({ name: "exec_command" }),
}));
vi.mock("./exec/write-stdin-tool.js", () => ({
  registerWriteStdinTool: (pi: { registerTool(tool: { name: string }): void }) =>
    pi.registerTool({ name: "write_stdin" }),
}));

import { isAdapterModel, reconcileTools, type AdapterToolState } from "./activation.js";
import registerCodexAdapter from "./index.js";

const model = (provider: string, id = "model", api = "api") => ({ provider, id, api });

describe("Codex adapter activation", () => {
  test("recognizes Codex models and exact configured providers", () => {
    expect(isAdapterModel(model("openai-codex", "gpt-5.3-codex"), [])).toBe(true);
    expect(isAdapterModel(model("proxy", "team-codex-model"), [])).toBe(true);
    expect(isAdapterModel(model("GitHub-Copilot", "gpt-5"), [" github-copilot "])).toBe(true);
    expect(isAdapterModel(model("github-copilot-enterprise", "gpt-5"), ["github-copilot"])).toBe(
      false,
    );
    expect(isAdapterModel(model("github-copilot", "gpt-5"), [])).toBe(false);
  });

  test("replaces active core tools while preserving unrelated order", () => {
    const state: AdapterToolState = {};
    expect(
      reconcileTools(["read", "custom-a", "edit", "bash", "write", "custom-b"], true, state),
    ).toEqual(["exec_command", "write_stdin", "apply_patch", "custom-a", "custom-b"]);
    expect(
      reconcileTools(
        ["exec_command", "write_stdin", "apply_patch", "custom-a", "custom-b"],
        false,
        state,
      ),
    ).toEqual(["read", "custom-a", "edit", "bash", "write", "custom-b"]);
  });

  test("restores displaced tools that originally preceded every unrelated tool", () => {
    const state: AdapterToolState = {};
    expect(reconcileTools(["edit", "write", "read"], true, state)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
    ]);
    expect(reconcileTools(["exec_command", "write_stdin", "apply_patch"], false, state)).toEqual([
      "edit",
      "write",
      "read",
    ]);
  });

  test("restores core tools first encountered during repeated in-scope reconciliation", () => {
    const state: AdapterToolState = {};
    expect(reconcileTools(["read", "write", "custom"], true, state)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "custom",
    ]);
    expect(
      reconcileTools(["exec_command", "write_stdin", "apply_patch", "edit", "custom"], true, state),
    ).toEqual(["exec_command", "write_stdin", "apply_patch", "custom"]);
    expect(
      reconcileTools(["exec_command", "write_stdin", "apply_patch", "custom"], false, state),
    ).toEqual(["read", "write", "edit", "custom"]);
  });

  test("leaves core tools unchanged when the model starts outside adapter scope", () => {
    const state: AdapterToolState = {};
    expect(reconcileTools(["read", "edit", "write", "bash", "apply_patch"], false, state)).toEqual([
      "read",
      "edit",
      "write",
      "bash",
    ]);
    expect(reconcileTools(["read", "edit", "write", "bash"], false, state)).toEqual([
      "read",
      "edit",
      "write",
      "bash",
    ]);
  });

  test("does not resurrect core tools that were inactive", () => {
    const state: AdapterToolState = {};
    expect(reconcileTools(["read", "write", "custom"], true, state)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "custom",
    ]);
    expect(
      reconcileTools(["exec_command", "write_stdin", "apply_patch", "custom"], false, state),
    ).toEqual(["read", "write", "custom"]);

    const noWrites: AdapterToolState = {};
    expect(reconcileTools(["read", "bash", "custom", "apply_patch"], true, noWrites)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "custom",
    ]);
    expect(
      reconcileTools(["exec_command", "write_stdin", "apply_patch", "custom"], false, noWrites),
    ).toEqual(["read", "bash", "custom"]);
  });

  test("session shutdown restores the exact front-of-list core order", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    let active = ["edit", "write", "read"];
    registerCodexAdapter(
      {
        registerTool: vi.fn(),
        on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
        getActiveTools: () => active,
        setActiveTools: (tools: string[]) => {
          active = tools;
        },
      } as never,
      { current: {} },
    );

    handlers.get("session_start")?.({}, { model: model("openai-codex") });
    expect(active).toEqual(["exec_command", "write_stdin", "apply_patch"]);
    handlers.get("session_shutdown")?.({}, {});
    expect(shutdown).toHaveBeenCalled();
    expect(active).toEqual(["edit", "write", "read"]);
  });

  test("session shutdown cleans up processes when tool restoration fails", async () => {
    shutdown.mockClear();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerCodexAdapter(
      {
        registerTool: vi.fn(),
        on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
        getActiveTools: () => ["exec_command"],
        setActiveTools: () => {
          throw new Error("restore failed");
        },
      } as never,
      { current: {} },
    );

    await expect(handlers.get("session_shutdown")?.({}, {})).rejects.toThrow("restore failed");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  test("lifecycle reconciliation never retains stale ctx", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    let active = ["read", "bash", "edit", "write", "custom"];
    const pi = {
      registerTool: vi.fn(),
      on: vi.fn((name: string, handler: (event: any, ctx: any) => void) =>
        handlers.set(name, handler),
      ),
      getActiveTools: vi.fn(() => active),
      setActiveTools: vi.fn((tools: string[]) => {
        active = tools;
      }),
    };
    registerCodexAdapter(pi as never, { current: { codexAdapter: { providers: ["bedrock"] } } });
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "apply_patch",
      "exec_command",
      "write_stdin",
    ]);

    let stale = false;
    const ctx = {
      get model() {
        if (stale) throw new Error("stale ctx model");
        return model("openai-codex", "gpt-5.3-codex");
      },
    };
    handlers.get("session_start")?.({}, ctx);
    stale = true;
    expect(active).toEqual(["exec_command", "write_stdin", "apply_patch", "custom"]);

    handlers.get("model_select")?.(
      { model: model("other") },
      {
        get model() {
          throw new Error("model_select must use the event snapshot");
        },
      },
    );
    expect(active).toEqual(["read", "bash", "edit", "write", "custom"]);
  });
});
