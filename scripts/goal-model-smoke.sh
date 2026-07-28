#!/usr/bin/env bash
set -euo pipefail

: "${PI_GOAL_SMOKE_MODEL:?Set PI_GOAL_SMOKE_MODEL to a configured provider/model.}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

output="$tmp/events.jsonl"
(
  cd "$tmp"
  pi --mode json --print --model "$PI_GOAL_SMOKE_MODEL" --no-extensions \
    --extension "$root/packages/ext/index.ts" \
    --session-dir "$tmp/sessions" \
    --tools create_goal,get_goal,update_goal,bash \
    'Use create_goal to explicitly pursue: "write and verify smoke.txt containing goal smoke passed". Write the file with bash. Then inspect it in a separate bash call using cat smoke.txt and inspect the active goal with get_goal. Only after that evidence verifies the objective, mark it complete with update_goal. Call get_goal once more and report its exact tokensUsed and timeUsedSeconds values in the final response.'
) | tee "$output"

node - "$output" <<'NODE'
const fs = require("node:fs");
const events = fs
  .readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const indexed = events.map((event, index) => ({ event, index }));
const starts = indexed.filter(({ event }) => event.type === "tool_execution_start");
const ends = indexed.filter(({ event }) => event.type === "tool_execution_end");
const requireStart = (tool) => {
  const call = starts.find(({ event }) => event.toolName === tool);
  if (!call) throw new Error(`missing ${tool}`);
  return call;
};
requireStart("create_goal");
const update = requireStart("update_goal");
const inspection = starts.find(
  ({ event }) =>
    event.toolName === "bash" && /\bcat\s+(?:\.\/)?smoke\.txt\b/.test(event.args?.command ?? ""),
);
if (!inspection) throw new Error("missing separate cat smoke.txt inspection");
const inspectionResult = ends.find(
  ({ event }) => event.toolCallId === inspection.event.toolCallId,
);
if (
  !inspectionResult ||
  !JSON.stringify(inspectionResult.event.result).includes("goal smoke passed") ||
  inspectionResult.index > update.index
) {
  throw new Error("file evidence was not observed before completion");
}
const updateResult = ends.find(
  ({ event }) => event.toolCallId === update.event.toolCallId,
);
if (
  !updateResult ||
  updateResult.event.isError ||
  updateResult.event.result?.details?.goal?.status !== "complete"
) {
  throw new Error("update_goal did not complete successfully");
}
const gets = ends.filter(({ event }) => event.toolName === "get_goal");
const beforeCompletion = gets.find(({ index }) => index < update.index);
const finalGet = gets.findLast(({ index }) => index > updateResult.index);
if (!beforeCompletion || !finalGet) {
  throw new Error("goal must be inspected before completion and after update_goal finishes");
}
const inspectedGoal = beforeCompletion.event.result?.details?.goal;
if (
  beforeCompletion.index < inspectionResult.index ||
  inspectedGoal?.status !== "active" ||
  inspectedGoal?.objective !== "write and verify smoke.txt containing goal smoke passed"
) {
  throw new Error("active goal was not inspected after file verification");
}
const finalDetails = finalGet.event.result?.details;
if (finalDetails?.goal?.status !== "complete") throw new Error("goal was not completed");
const tokens = finalDetails.goal.tokensUsed;
const seconds = finalDetails.goal.timeUsedSeconds;
if (!Number.isInteger(tokens) || !Number.isInteger(seconds)) {
  throw new Error("final get_goal omitted actual usage values");
}
const finalText =
  events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .flatMap((event) => event.message.content ?? [])
    .filter((part) => part.type === "text")
    .at(-1)?.text?.replaceAll(",", "") ?? "";
const reports = (label, value) => {
  const exactValue = `(?<!\\d)${value}(?!\\d)`;
  return new RegExp(
    `(?:${label}[^\\d]{0,30}${exactValue}|${exactValue}[^\\d]{0,30}${label})`,
    "i",
  ).test(finalText);
};
if (
  !reports("tokens?(?:Used)?", tokens) ||
  !reports("(?:timeUsedSeconds|elapsed|seconds?)", seconds)
) {
  throw new Error(`final response did not report exact usage: ${tokens} tokens, ${seconds} seconds`);
}
NODE

test "$(cat "$tmp/smoke.txt")" = "goal smoke passed"
echo "goal model smoke passed"
