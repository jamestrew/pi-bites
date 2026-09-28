import { expect, test } from "vitest";
import { checkLifecycle, type Operation } from "./subagents-route-smoke.js";
import { findMatchedPatterns } from "../packages/ext/bash-gate/policy.js";

test("V2 smoke requires ordered completion, retained-task recall and direct mailbox/message results", async () => {
  const result = (value: unknown) => ({
    content: [{ type: "text", text: value === "" ? "" : JSON.stringify(value) }],
  });
  const listed = (answer: string) =>
    result({ agents: [{ agent_name: "/root/probe", agent_status: { completed: answer } }] });
  const operations: Operation[] = [
    {
      owner: "parent",
      name: "spawn_agent",
      args: {
        task_name: "probe",
        agent_type: "default",
        model: "provider/model",
        message: "Retain V2_RETAINED_352; printf subagent-approved",
      },
      result: result({ task_name: "/root/probe" }),
    },
    {
      owner: "/root/probe",
      name: "send_message",
      args: { target: "/root", message: "progress" },
      result: result(""),
    },
    {
      owner: "parent",
      name: "wait_agent",
      args: {},
      result: result({ message: "Wait completed.", timed_out: false }),
    },
    { owner: "parent", name: "list_agents", args: {}, result: listed("done") },
    {
      owner: "parent",
      name: "interrupt_agent",
      args: { target: "/root/probe" },
      result: result({ previous_status: { completed: "done" } }),
    },
    {
      owner: "parent",
      name: "followup_task",
      args: { target: "/root/probe", message: "Recall the retained marker" },
      result: result(""),
    },
    { owner: "parent", name: "list_agents", args: {}, result: listed("V2_RETAINED_352") },
  ];
  expect(Object.values(checkLifecycle(operations, "provider/model")).every(Boolean)).toBe(true);
  for (const mutate of [
    (copy: Operation[]) => {
      copy[5]!.args.message = "Recall V2_RETAINED_352";
    },
    (copy: Operation[]) => {
      copy[5]!.args.target = "/root/other";
    },
    (copy: Operation[]) => {
      copy[6]!.result = listed("I succeeded");
    },
    (copy: Operation[]) => {
      copy.splice(3, 1);
    },
    (copy: Operation[]) => {
      copy[0]!.error = "provider failed";
    },
    (copy: Operation[]) => {
      copy[2]!.args.targets = ["old-id"];
    },
  ]) {
    const copy = structuredClone(operations);
    mutate(copy);
    expect(Object.values(checkLifecycle(copy, "provider/model")).every(Boolean)).toBe(false);
  }
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
