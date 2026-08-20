import { describe, expect, it } from "vitest";
import { getActiveSubagent, runAsSubagent } from "../subagent-context.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("subagent async context", () => {
  it("keeps parallel loader identities isolated", async () => {
    const releaseA = deferred();
    const releaseB = deferred();

    const a = runAsSubagent("a", async () => {
      await releaseA.promise;
      return getActiveSubagent();
    });
    const b = runAsSubagent("b", async () => {
      await releaseB.promise;
      return getActiveSubagent();
    });

    releaseB.resolve();
    releaseA.resolve();

    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(getActiveSubagent()).toBeUndefined();
  });
});
