import { expect, test } from "vitest";
import {
  isAdapterModel,
  reconcileTools,
  createAdapterToolState,
  getNestedTools,
  getDelegationTools,
} from "./activation.js";

test("only GPT-5.6/GPT-6/GPT-6.1 families and recognized prefixes enter Code Mode", () => {
  for (const id of [
    "gpt-5.6",
    "gpt-5.6-pro",
    "gpt-6",
    "gpt-6.1",
    "openai/gpt-6.1-sol",
    "gpt-6-astra",
    "openai/gpt-6-astra",
    "openai-codex/gpt-5.6",
    "github-copilot/gpt-6",
    " GPT-6-SOL ",
  ])
    expect(isAdapterModel({ id, provider: "proxy" })).toBe(true);
  for (const id of [
    "gpt-5",
    "gpt-5.60",
    "gpt-6.10-sol",
    "gpt-6.1-sol-extra",
    "gpt-6.1-luna",
    "unknown/gpt-6.1-sol",
    "gpt-60",
    "gpt-7",
    "team-codex-model",
    "claude",
    "unknown/gpt-6",
    "gpt-6-",
    "gpt-6/astra",
  ])
    expect(isAdapterModel({ id, provider: "openai-codex", api: "openai-codex-responses" })).toBe(
      false,
    );
});

test("hides owned direct tools, restores only displaced core tools, and retains unrelated tools", () => {
  const state = createAdapterToolState();
  const active = reconcileTools(
    [
      "read",
      "custom",
      "bash",
      "exec_command",
      "write_stdin",
      "apply_patch",
      "web_run",
      "view_image",
      "codemode",
    ],
    true,
    state,
  );
  expect(active).toEqual(["codemode", "custom"]);
  expect([...getNestedTools(state)]).toEqual([
    "exec_command",
    "write_stdin",
    "web_run",
    "view_image",
  ]);
  expect(reconcileTools(active, false, state)).toEqual(["read", "custom", "bash"]);
});

test("model switches preserve hidden availability and session-disabled codemode stays disabled", () => {
  const state = createAdapterToolState();
  const initial = [
    "read",
    "bash",
    "edit",
    "custom",
    "exec_command",
    "apply_patch",
    "web_run",
    "view_image",
    "codemode",
  ];
  const outside = reconcileTools(initial, false, state);
  const active = reconcileTools(outside, true, state);
  expect(getNestedTools(state).has("web_run")).toBe(true);
  expect(
    reconcileTools(
      active.filter((name) => name !== "codemode"),
      true,
      state,
    ),
  ).toEqual(["read", "bash", "edit", "custom"]);
  expect(reconcileTools(["read", "bash", "edit", "custom"], true, state)).toEqual([
    "read",
    "bash",
    "edit",
    "custom",
  ]);
});

test("session selection cannot recover disabled nested capabilities from core aliases", () => {
  const state = createAdapterToolState();
  expect(reconcileTools(["read", "bash", "write", "custom", "codemode"], true, state)).toEqual([
    "read",
    "bash",
    "write",
    "custom",
    "codemode",
  ]);
  expect([...getNestedTools(state)]).toEqual([]);
  const readonly = createAdapterToolState();
  expect(reconcileTools(["read", "exec_command", "codemode"], true, readonly)).toEqual([
    "read",
    "codemode",
  ]);
  expect([...getNestedTools(readonly)]).toEqual([]);
});

test("a session-disabled codemode remains disabled across unsupported and supported model switches", () => {
  const state = createAdapterToolState();
  const active = reconcileTools(["read", "bash", "exec_command", "codemode"], true, state);
  const outside = reconcileTools(
    active.filter((tool) => tool !== "codemode"),
    false,
    state,
  );
  const again = reconcileTools(outside, true, state);
  expect(again).toEqual(["read", "bash"]);
});

test("session can explicitly re-enable codemode after disabling it", () => {
  const name = "codemode";
  const state = createAdapterToolState();
  const active = reconcileTools(
    ["read", "bash", "exec_command", "codemode", "custom"],
    true,
    state,
  );
  const disabled = reconcileTools(
    active.filter((tool) => tool !== name),
    true,
    state,
  );
  expect(disabled).not.toContain(name);
  expect(reconcileTools([...disabled, name], true, state)).toEqual(["codemode", "custom"]);
});

test("re-enabling codemode honors core capabilities removed while it was disabled", () => {
  const state = createAdapterToolState();
  const initial = reconcileTools(["read", "bash", "exec_command", "codemode"], true, state);
  const disabled = reconcileTools(
    initial.filter((name) => name !== "codemode"),
    true,
    state,
  );
  const readonly = reconcileTools(
    disabled.filter((name) => name !== "bash"),
    true,
    state,
  );
  expect(reconcileTools([...readonly, "codemode"], true, state)).toEqual(["read", "codemode"]);
  expect([...getNestedTools(state)]).toEqual([]);
});

test("delegation snapshots recover permitted capabilities without changing parent exposure", () => {
  const state = createAdapterToolState();
  const selected = [
    "read",
    "bash",
    "custom",
    "codemode",
    "exec_command",
    "write_stdin",
    "apply_patch",
  ];
  const active = reconcileTools(selected, true, state);
  expect(active).toEqual(["codemode", "custom"]);
  const before = structuredClone(state);
  const allowed = getDelegationTools(active, state);
  expect(allowed).toEqual(
    expect.arrayContaining(["read", "bash", "custom", "codemode", "exec_command", "write_stdin"]),
  );
  expect(allowed).not.toContain("edit");
  expect(allowed).not.toContain("write");
  expect(allowed).not.toContain("apply_patch");
  expect(state).toEqual(before);
  const outside = reconcileTools(active, false, state);
  expect(getDelegationTools(outside, state)).toEqual(expect.arrayContaining(allowed));
});

test("selected collaboration remains direct across projection changes", () => {
  const state = createAdapterToolState();
  const selected = ["custom", "spawn_agent", "wait_agent", "codemode"];
  const active = reconcileTools(selected, true, state);
  expect(active).toEqual(selected);
  expect([...getNestedTools(state)]).toEqual([]);
  expect(getDelegationTools(active, state)).toContain("spawn_agent");
  expect(getDelegationTools(active, state)).not.toContain("send_message");
  expect(reconcileTools(active, false, state)).toEqual(["custom", "spawn_agent", "wait_agent"]);
  const again = reconcileTools(["custom", "spawn_agent", "wait_agent"], true, state);
  expect(again).toEqual(selected);
  expect(
    reconcileTools(
      again.filter((name) => name !== "spawn_agent" && name !== "codemode"),
      true,
      state,
    ),
  ).toEqual(["custom", "wait_agent"]);
});
