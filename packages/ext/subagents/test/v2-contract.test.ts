import { afterEach, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { harness } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it("preserves the inline model-facing collaboration contract", () => {
  const { direct } = harness(cleanup);
  expect({
    tools: [...direct.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    roles: Object.fromEntries(
      Object.entries(DEFAULT_AGENTS).map(([name, role]) => [name, role.description]),
    ),
  }).toMatchSnapshot();
});
