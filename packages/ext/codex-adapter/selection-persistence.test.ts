import type { ExtensionUIContext, FileEntry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { setup, textOf } from "./test/native-session.js";

test("reopening a projected session preserves nested shell and patch permissions", async () => {
  const original = await setup(undefined, { persist: true });
  await original.run("text('saved');");
  const sessionFile = original.session.sessionManager.getSessionFile()!;
  await original.close();

  const resumed = await setup(undefined, { sessionFile });
  const patch = "*** Begin Patch\n*** Add File: resumed.txt\n+restored\n*** End Patch";
  const result = await resumed.run(`
    text((await tools.exec_command({cmd:'printf resumed',login:false})).output);
    text(await tools.apply_patch({input:${JSON.stringify(patch)}}));
  `);
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain("resumed");
  expect(textOf(result)).toContain('"status":"success"');
});

test.each(["defaults", "registry", "exclude"] as const)(
  "reopening with a read-only %s policy overrides saved shell and patch permissions",
  async (policy) => {
    const original = await setup(undefined, { persist: true });
    await original.run("text('saved');");
    const sessionFile = original.session.sessionManager.getSessionFile()!;
    await original.close();

    const resumed = await setup(
      policy === "registry" ? ["read", "codemode", "exec_command", "apply_patch"] : undefined,
      {
        sessionFile,
        ...(policy === "defaults" ? { defaultTools: ["read", "codemode"] } : {}),
        ...(policy === "exclude" ? { excludeTools: ["bash", "edit", "write"] } : {}),
      },
    );
    expect(resumed.session.getCallableToolNames()).not.toContain("exec_command");
    expect(resumed.session.getCallableToolNames()).not.toContain("apply_patch");
    expect((await resumed.run("await tools.exec_command({cmd:'touch forbidden'});")).isError).toBe(
      true,
    );
  },
);

test.each(["modifiers", "no-builtin-tools"] as const)(
  "reopening respects soft %s restrictions even when core tools remain registered",
  async (policy) => {
    const original = await setup(undefined, { persist: true });
    await original.run("text('saved');");
    const sessionFile = original.session.sessionManager.getSessionFile()!;
    await original.close();

    const resumed = await setup(policy === "modifiers" ? ["-bash", "-edit", "-write"] : undefined, {
      sessionFile,
      ...(policy === "no-builtin-tools" ? { noTools: "builtin" } : {}),
    });
    expect(resumed.session.getAllTools().map((tool) => tool.name)).toContain("bash");
    expect(resumed.session.getCallableToolNames()).not.toContain("exec_command");
    expect(resumed.session.getCallableToolNames()).not.toContain("apply_patch");
  },
);

test("reopening preserves a session-disabled codemode", async () => {
  const original = await setup(undefined, { persist: true });
  await original.run("text('saved');");
  original.setTools([]);
  await original.call("read", { path: "missing.txt" });
  expect(original.session.getActiveToolNames()).not.toContain("codemode");
  const sessionFile = original.session.sessionManager.getSessionFile()!;
  await original.close();

  const resumed = await setup(undefined, { sessionFile });
  expect(resumed.session.getActiveToolNames()).not.toContain("codemode");
  expect(resumed.session.getCallableToolNames()).not.toContain("exec_command");
});

test("reopening does not re-enable explicitly disabled nested tools", async () => {
  const original = await setup(undefined, {
    persist: true,
    defaultTools: ["-exec_command", "-apply_patch"],
  });
  await original.run("text('saved');");
  const sessionFile = original.session.sessionManager.getSessionFile()!;
  await original.close();

  const resumed = await setup(undefined, { sessionFile });
  expect(resumed.session.getCallableToolNames()).not.toContain("exec_command");
  expect(resumed.session.getCallableToolNames()).not.toContain("apply_patch");
});

test("explicit additions can re-enable previously disabled nested capabilities", async () => {
  const original = await setup(undefined, {
    persist: true,
    defaultTools: ["-exec_command", "-apply_patch"],
  });
  await original.run("text('saved');");
  const sessionFile = original.session.sessionManager.getSessionFile()!;
  await original.close();

  const resumed = await setup(["+exec_command", "+apply_patch"], { sessionFile });
  const result = await resumed.run(
    "text((await tools.exec_command({cmd:'printf enabled',login:false})).output);",
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(resumed.session.getCallableToolNames()).toContain("apply_patch");
});

test("legacy transcripts need explicit permission re-selection, not inferred declarations", async () => {
  const original = await setup();
  await original.run("text('legacy session');");
  // Older sessions contain the projected declarations but no adapter checkpoints.
  const entries: FileEntry[] = structuredClone(
    original.session.sessionManager.getEntries().filter((entry) => entry.type !== "custom"),
  );
  const legacy = await setup(undefined, { entries });
  expect(legacy.session.getActiveToolNames()).toContain("codemode");
  expect(legacy.session.getCallableToolNames()).not.toContain("exec_command");
  expect(legacy.session.getCallableToolNames()).not.toContain("apply_patch");

  const repaired = await setup(["+read", "+bash", "+edit", "+write"], {
    entries: structuredClone(entries),
  });
  const result = await repaired.run(
    "text((await tools.exec_command({cmd:'printf repaired',login:false})).output);",
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain("repaired");
});

test("reload preserves the selected codemode and its underlying capabilities", async () => {
  const h = await setup();
  await h.session.bindExtensions({ uiContext: h.ui as unknown as ExtensionUIContext });
  await h.run("text('before reload');");
  await h.session.reload();
  expect(h.session.getActiveToolNames()).toContain("codemode");
  const result = await h.run(
    "text((await tools.exec_command({cmd:'printf reloaded',login:false})).output);",
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain("reloaded");
});

test("tree navigation restores each branch's selection without leaking shell permissions", async () => {
  const h = await setup();
  await h.run("text('full access branch');");
  const fullAccess = h.session.sessionManager.getLeafId()!;

  h.setTools([]);
  await h.call("read", { path: "missing.txt" });
  h.setTools(["read", "codemode"]);
  await h.run("text('read-only branch');");
  const readOnly = h.session.sessionManager.getLeafId()!;
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");

  await h.session.navigateTree(fullAccess, { summarize: false });
  const result = await h.run(
    "text((await tools.exec_command({cmd:'printf restored',login:false})).output);",
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain("restored");

  await h.session.navigateTree(readOnly, { summarize: false });
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  expect(h.session.getCallableToolNames()).not.toContain("apply_patch");
});

test("reopening a read-only session does not acquire shell or patch permissions", async () => {
  const original = await setup(undefined, {
    persist: true,
    defaultTools: ["read", "codemode"],
  });
  await original.run("text('saved');");
  const sessionFile = original.session.sessionManager.getSessionFile()!;
  await original.close();

  const resumed = await setup(undefined, { sessionFile });
  expect(resumed.session.getCallableToolNames()).not.toContain("exec_command");
  expect(resumed.session.getCallableToolNames()).not.toContain("apply_patch");
  expect((await resumed.run("await tools.exec_command({cmd:'touch forbidden'});")).isError).toBe(
    true,
  );
});
