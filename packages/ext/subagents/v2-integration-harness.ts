import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagents } from "./index.js";
import { createV2Tools } from "./v2-tools.js";

/** Test-only staged integration; deliberately not imported by extension activation. */
export function createV2IntegrationHarness(pi: ExtensionAPI) {
  const operations = createSubagents(
    pi,
    undefined,
    undefined,
    undefined,
    undefined,
    (pi, deps) => ({
      tools: createV2Tools(pi, deps),
      registration: {
        directOnly: true,
        childPrompt: (record) => {
          if (!record.taskName) throw new Error("Named agent has no task path");
          return `\nYour canonical task_name is ${record.taskName}. Relative task paths resolve beneath your path; /root is the root agent.`;
        },
      },
    }),
  );
  operations.registerTools();
  return operations;
}
