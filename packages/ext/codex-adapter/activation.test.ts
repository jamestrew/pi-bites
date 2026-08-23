import { describe, expect, test, vi } from "vitest";

vi.mock("./apply-patch/tool.js", () => ({
  registerApplyPatchTool: (pi: { registerTool(tool: { name: string }): void }) =>
    pi.registerTool({ name: "apply_patch" }),
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

  test("replaces only active edit and write while preserving unrelated order", () => {
    const state: AdapterToolState = {};
    expect(
      reconcileTools(["read", "custom-a", "edit", "bash", "write", "custom-b"], true, state),
    ).toEqual(["read", "custom-a", "apply_patch", "bash", "custom-b"]);
    expect(
      reconcileTools(["read", "custom-a", "apply_patch", "bash", "custom-b"], false, state),
    ).toEqual(["read", "custom-a", "edit", "bash", "write", "custom-b"]);
  });

  test("restores displaced tools that originally preceded every unrelated tool", () => {
    const state: AdapterToolState = {};
    expect(reconcileTools(["edit", "write", "read"], true, state)).toEqual(["apply_patch", "read"]);
    expect(reconcileTools(["apply_patch", "read"], false, state)).toEqual([
      "edit",
      "write",
      "read",
    ]);
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
      "read",
      "apply_patch",
      "custom",
    ]);
    expect(reconcileTools(["read", "apply_patch", "custom"], false, state)).toEqual([
      "read",
      "write",
      "custom",
    ]);

    const noWrites: AdapterToolState = {};
    expect(reconcileTools(["read", "bash", "custom", "apply_patch"], true, noWrites)).toEqual([
      "read",
      "bash",
      "custom",
    ]);
    expect(reconcileTools(["read", "bash", "custom"], false, noWrites)).toEqual([
      "read",
      "bash",
      "custom",
    ]);
  });

  test("session shutdown restores the exact front-of-list core order", () => {
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
    expect(active).toEqual(["apply_patch", "read"]);
    handlers.get("session_shutdown")?.({}, {});
    expect(active).toEqual(["edit", "write", "read"]);
  });

  test("lifecycle reconciliation never retains stale ctx", () => {
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

    let stale = false;
    const ctx = {
      get model() {
        if (stale) throw new Error("stale ctx model");
        return model("openai-codex", "gpt-5.3-codex");
      },
    };
    handlers.get("session_start")?.({}, ctx);
    stale = true;
    expect(active).toEqual(["read", "bash", "apply_patch", "custom"]);

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
