import { expect, test } from "vitest";
import { checkLifecycle, type Operation } from "./subagents-route-smoke.js";
import { findMatchedPatterns } from "../packages/ext/bash-gate/policy.js";

test("real-shaped V1 results require ordered retained-id lifecycle and unprompted recall", async () => {
  const result = (value: unknown, details = {}) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    details,
  });
  const operations: Operation[] = [
    {
      owner: "parent",
      name: "spawn_agent",
      args: {
        agent_type: "default",
        model: "provider/model",
        message: "Retain V1_RETAINED_278; printf subagent-approved",
      },
      result: result({ agent_id: "child", nickname: "Default" }),
    },
    {
      owner: "child",
      name: "send_input",
      args: { target: "parent-session", message: "progress" },
      result: result({ submission_id: "progress-id" }),
    },
    {
      owner: "parent",
      name: "wait_agent",
      args: { targets: ["child"] },
      result: result({ status: { child: { completed: "done" } }, timed_out: false }),
    },
    {
      owner: "parent",
      name: "close_agent",
      args: { target: "child" },
      result: result({ previous_status: { completed: "done" } }, { status: "closed" }),
    },
    {
      owner: "parent",
      name: "resume_agent",
      args: { id: "child" },
      result: result({ status: "pending_init" }, { status: "resumed" }),
    },
    {
      owner: "parent",
      name: "send_input",
      args: { target: "child", message: "Recall the retained marker" },
      result: result({ submission_id: "recall-id" }),
    },
    {
      owner: "parent",
      name: "wait_agent",
      args: { targets: ["child"] },
      result: result({ status: { child: { completed: "V1_RETAINED_278" } }, timed_out: false }),
    },
    {
      owner: "parent",
      name: "close_agent",
      args: { target: "child" },
      result: result({ previous_status: { completed: "V1_RETAINED_278" } }, { status: "closed" }),
    },
  ];
  expect(Object.values(checkLifecycle(operations, "provider/model")).every(Boolean)).toBe(true);
  for (const mutate of [
    (copy: Operation[]) => {
      copy[5]!.args.message = "Recall V1_RETAINED_278";
    },
    (copy: Operation[]) => {
      copy[4]!.args.id = "other-child";
    },
    (copy: Operation[]) => {
      copy[6]!.result = result({ status: { child: "running" }, timed_out: true });
    },
    (copy: Operation[]) => {
      copy[6]!.result = result({
        status: { child: { completed: "I succeeded" } },
        timed_out: false,
      });
    },
    (copy: Operation[]) => {
      copy.splice(3, 1);
    },
    (copy: Operation[]) => {
      copy[0]!.error = "provider failed";
    },
  ]) {
    const copy = structuredClone(operations);
    mutate(copy);
    expect(Object.values(checkLifecycle(copy, "provider/model")).every(Boolean)).toBe(false);
  }
  // Harness all-command configuration must override even normally allowlisted commands.
  for (const command of [
    "printf subagent-approved",
    "printf unexpected",
    "ls",
    "pwd",
    "touch unexpected",
  ])
    expect((await findMatchedPatterns(command, { rules: [{ cmd: [] }] })).length).toBeGreaterThan(
      0,
    );
});
