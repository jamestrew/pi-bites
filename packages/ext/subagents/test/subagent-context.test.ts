import { describe, expect, it } from "vitest";
import { getActiveSubagent, getChildCollaboration, runAsSubagent } from "../subagent-context.js";

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

it("keeps the cross-version role marker compatible while scoping child registration", async () => {
  const register = (() => {
    throw new Error("not invoked");
  }) as import("../subagent-context.js").RegisterCollaboration;
  await runAsSubagent({ type: "worker", registerCollaboration: register }, async () => {
    await Promise.resolve();
    const legacyStorage = Reflect.get(globalThis, Symbol.for("pi-bites:subagent-context"));
    expect(legacyStorage.getStore()).toBe("worker");
    expect(getChildCollaboration()).toBe(register);
    await runAsSubagent("explorer", async () => {
      expect(getChildCollaboration()).toBeUndefined();
    });
    expect(getChildCollaboration()).toBe(register);
  });
  expect(getChildCollaboration()).toBeUndefined();
});
