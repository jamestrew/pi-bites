import { expect, test } from "vitest";
import {
  isAdapterModel,
  reconcileTools,
  createAdapterToolState,
  getNestedTools,
} from "./activation.js";

test("only GPT-5.6/GPT-6 families and recognized prefixes enter Code Mode", () => {
  for (const id of [
    "gpt-5.6",
    "gpt-5.6-pro",
    "gpt-6",
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
    "gpt-6.1",
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
      "exec",
      "wait",
    ],
    true,
    state,
  );
  expect(active).toEqual(["exec", "wait", "custom"]);
  expect([...getNestedTools(state)]).toEqual([
    "exec_command",
    "write_stdin",
    "web_run",
    "view_image",
  ]);
  expect(reconcileTools(active, false, state)).toEqual(["read", "custom", "bash"]);
});

test("model switches preserve hidden availability and session-disabled exec stays disabled", () => {
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
    "exec",
    "wait",
  ];
  const outside = reconcileTools(initial, false, state);
  const active = reconcileTools(outside, true, state);
  expect(getNestedTools(state).has("web_run")).toBe(true);
  expect(
    reconcileTools(
      active.filter((name) => name !== "exec"),
      true,
      state,
    ),
  ).toEqual(["read", "bash", "edit", "custom", "wait"]);
  expect(reconcileTools(["read", "bash", "edit", "custom", "wait"], true, state)).toEqual([
    "read",
    "bash",
    "edit",
    "custom",
    "wait",
  ]);
});

test("session selection cannot recover disabled nested capabilities from core aliases", () => {
  const state = createAdapterToolState();
  expect(reconcileTools(["read", "bash", "write", "custom", "exec", "wait"], true, state)).toEqual([
    "read",
    "bash",
    "write",
    "custom",
    "exec",
    "wait",
  ]);
  expect([...getNestedTools(state)]).toEqual([]);
  const readonly = createAdapterToolState();
  expect(reconcileTools(["read", "exec_command", "exec", "wait"], true, readonly)).toEqual([
    "read",
    "exec",
    "wait",
  ]);
  expect([...getNestedTools(readonly)]).toEqual([]);
});

test("a session-disabled exec remains disabled across unsupported and supported model switches", () => {
  const state = createAdapterToolState();
  const active = reconcileTools(["read", "bash", "exec_command", "exec", "wait"], true, state);
  const outside = reconcileTools(
    active.filter((tool) => tool !== "exec"),
    false,
    state,
  );
  const again = reconcileTools(outside, true, state);
  expect(again).toEqual(["read", "bash", "wait"]);
});

test.each(["exec", "wait"])("session can explicitly re-enable %s after disabling it", (name) => {
  const state = createAdapterToolState();
  const active = reconcileTools(
    ["read", "bash", "exec_command", "exec", "wait", "custom"],
    true,
    state,
  );
  const disabled = reconcileTools(
    active.filter((tool) => tool !== name),
    true,
    state,
  );
  expect(disabled).not.toContain(name);
  expect(reconcileTools([...disabled, name], true, state)).toEqual(["exec", "wait", "custom"]);
});

test("re-enabling exec honors core capabilities removed while it was disabled", () => {
  const state = createAdapterToolState();
  const initial = reconcileTools(["read", "bash", "exec_command", "exec", "wait"], true, state);
  const disabled = reconcileTools(
    initial.filter((name) => name !== "exec"),
    true,
    state,
  );
  const readonly = reconcileTools(
    disabled.filter((name) => name !== "bash"),
    true,
    state,
  );
  expect(reconcileTools([...readonly, "exec"], true, state)).toEqual(["read", "exec", "wait"]);
  expect([...getNestedTools(state)]).toEqual([]);
});
