import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { setup, textOf } from "./test/native-session.js";
import type { CommandAuthorizationRequest } from "../bash-gate/index.js";

test("parent uses host-free native discovery and typed parallel shell results", async () => {
  const h = await setup();
  expect(h.session.getActiveToolNames()).toContain("codemode");
  expect(h.session.getActiveToolNames()).not.toContain("exec");
  expect(h.session.getActiveToolNames()).not.toContain("wait");
  const result = await h.run(
    `text(ALL_TOOLS.map(t=>t.name)); text(await Promise.all([tools.exec_command({cmd:'printf hello',login:false}),tools.exec_command({cmd:'printf failed; exit 7',login:false})]));`,
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain('"output":"hello"');
  expect(textOf(result)).toContain('"exit_code":7');
  expect(textOf(result)).not.toContain("web_run");
  const nested = h.events.filter(
    (e) => e.type === "tool_execution_end" && e.toolName === "exec_command",
  );
  expect(nested).toHaveLength(2);
  expect(new Set(nested.map((e) => e.toolCallId)).size).toBe(2);
});

test("native patch accepts object and raw string, reports partial mutation failure, and emits images only explicitly", async () => {
  const h = await setup();
  const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const applied = await h.run(`text(await tools.apply_patch(${JSON.stringify(patch)}));`);
  expect(applied.isError).toBe(false);
  expect(textOf(applied)).toContain('"status":"success"');
  const partial =
    "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch";
  const failed = await h.run(
    `text('before'); await tools.apply_patch({input:${JSON.stringify(partial)}}); text('unreachable');`,
  );
  expect(failed.isError).toBe(true);
  expect(textOf(failed)).toContain("before");
  expect(textOf(failed)).toContain("partially failed");
  expect(textOf(failed)).not.toContain("unreachable");
  const inspect = await h.run(
    `text((await tools.exec_command({cmd:'cat hello.txt created.txt',login:false})).output);`,
  );
  expect(textOf(inspect)).toContain("hello\ncreated");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(h.cwd, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const silent = await h.run(`store('picture',await tools.view_image({path:'pixel.png'}));`);
  expect(silent.result.content.some((c: any) => c.type === "image")).toBe(false);
  const shown = await h.run(`image(load('picture')); text('shown');`);
  expect(shown.result.content).toContainEqual(
    expect.objectContaining({ type: "image", mimeType: "image/png" }),
  );
  const missing = await h.run(`await tools.view_image({path:'missing.png'});`);
  expect(missing.isError).toBe(true);
});

test("normal completion and script error retain returned shell sessions for later polling", async () => {
  const h = await setup();
  const start = await h.run(
    `store('shell',await tools.exec_command({cmd:'sleep 0.5; printf later; exit 3',login:false,yield_time_ms:250})); text(load('shell').session_id);`,
  );
  expect(start.isError).toBe(false);
  const failed = await h.run(`text('retained'); throw new Error('native failure');`);
  expect(failed.isError).toBe(true);
  expect(textOf(failed)).toContain("retained");
  const poll = await h.run(`text(await tools.write_stdin({session_id:load('shell').session_id}));`);
  expect(textOf(poll)).toContain('"output":"later"');
  expect(textOf(poll)).toContain('"exit_code":3');
});

test("read-only registry selections cannot discover or call inactive shell and patch tools", async () => {
  const h = await setup([
    "read",
    "codemode",
    "exec_command",
    "write_stdin",
    "apply_patch",
    "view_image",
  ]);
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  expect(h.session.getCallableToolNames()).not.toContain("apply_patch");
  const discovered = await h.run(
    `text(ALL_TOOLS.map(t=>t.name)); text(await searchTools('shell command patch'));`,
  );
  expect(textOf(discovered)).not.toContain("exec_command");
  expect(textOf(discovered)).not.toContain("apply_patch");
  expect((await h.run(`await tools.exec_command({cmd:'touch forbidden'});`)).isError).toBe(true);
});

test("model transitions restore core selection, clear store, and do not broaden GPT scope", async () => {
  const h = await setup();
  await h.run(`store('old',42);`);
  await h.session.setModel(h.runtime.getModel("native-test", "claude")!);
  expect(h.session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "bash", "edit", "write"]),
  );
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  expect(h.session.getActiveToolNames()).not.toContain("codemode");
  await h.session.setModel(h.runtime.getModel("native-test", "gpt-6.1-sol")!);
  expect(h.session.getActiveToolNames()).toContain("codemode");
  expect(textOf(await h.run(`text(load('old'));`))).not.toContain("42");
});

test("separately enabled tool search cannot recover read-only tools or explicit disables", async () => {
  const h = await setup(undefined, {
    defaultTools: ["read", "codemode", "tool_search", "-exec_command", "-apply_patch"],
  });
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  const search = await h.call("tool_search", {
    query: "exec_command apply_patch shell patch",
    limit: 10,
  });
  expect(search.result.details.loaded).not.toContain("exec_command");
  expect(search.result.details.loaded).not.toContain("apply_patch");
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  h.config.current.disable = ["codexAdapter"];
  await h.session.extensionRunner.emit({
    type: "model_select",
    model: h.runtime.getModel("native-test", "gpt-6.1-sol")!,
    previousModel: undefined,
    source: "set",
  } as never);
  expect(h.session.getActiveToolNames()).not.toContain("codemode");
  expect(h.session.getCallableToolNames()).not.toContain("view_image");
});

test("web route returns text and collects citations once through native execution", async () => {
  const h = await setup(undefined, {
    config: { codexAdapter: { webSearchProviders: ["native-test"] } },
    defaultTools: ["+tool_search"],
  });
  const helper = join(h.cwd, "web-helper");
  const output = {
    output_text: "Evidence citeturn0search0",
    search_results: [{ ref_id: "turn0search0", url: "https://example.com/source" }],
  };
  writeFileSync(
    helper,
    `#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf '%s' '${JSON.stringify(output)}'\n`,
    {
      mode: 0o755,
    },
  );
  vi.stubEnv("PI_CODEX_WEB_RUN_BIN", helper);
  try {
    const search = await h.call("tool_search", { query: "web_run", limit: 1 });
    expect(search.result.details.loaded).toContain("web_run");
    const result = await h.run(
      `const value=await tools.web_run({search_query:[{q:'evidence'}]});text(typeof value);text(value);`,
    );
    expect(result.isError, textOf(result)).toBe(false);
    expect(textOf(result)).toContain("string");
    expect(textOf(result)).toContain("Evidence citeturn0search0");
    expect(h.transform("Evidence citeturn0search0")).toBe(
      "Evidence [source](<https://example.com/source>)",
    );
    expect(
      h.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "web_run"),
    ).toHaveLength(1);
    expect(h.session.getActiveToolNames()).toContain("web_run");
    h.config.current.codexAdapter = {};
    expect((await h.run(`await tools.web_run({search_query:[{q:'forbidden'}]});`)).isError).toBe(
      true,
    );
    expect(h.session.getCallableToolNames()).not.toContain("web_run");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("parallel shell reviews serialize dialogs, authorize once per launch, and pin launch cwd", async () => {
  const h = await setup(undefined, {
    gate: true,
    config: { bashGate: { rules: [{ cmd: "printf" }] } },
  });
  const first = Promise.withResolvers<string>();
  h.ui.select.mockImplementationOnce(() => first.promise);
  const pending = h.run(
    `text(await Promise.all([tools.exec_command({cmd:'printf one',login:false}),tools.exec_command({cmd:'printf two',login:false})]));`,
  );
  await expect.poll(() => h.ui.select.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(h.ui.select).toHaveBeenCalledTimes(1);
  first.resolve("Allow");
  const result = await pending;
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain('"output":"one"');
  expect(textOf(result)).toContain('"output":"two"');
  expect(h.ui.select).toHaveBeenCalledTimes(2);
});

test("native scripts retain independent bounded evidence for approval and saved results", async () => {
  const requests: CommandAuthorizationRequest[] = [];
  const h = await setup(undefined, { onAuthorization: (request) => requests.push(request) });
  const result = await h.run(`
    await tools.exec_command({cmd: "printf 'REAL_HEAD '; printf '%20000s' x; printf ' REAL_TAIL'", login: false});
    await tools.exec_command({cmd: "printf done", login: false});
  `);
  expect(result.isError, textOf(result)).toBe(false);
  expect(requests).toHaveLength(2);
  const evidence = JSON.stringify(requests[1]!.nestedEvidence);
  expect(evidence).toContain("REAL_HEAD");
  expect(evidence).toContain("REAL_TAIL");
  expect(evidence).toContain("omitted_approx_tokens");
  expect(evidence.length).toBeLessThan(6000);
  expect(result.result.details.reviewEvidence).toHaveLength(2);
  const saved = h.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(JSON.stringify(saved)).toContain("REAL_TAIL");
  await h.run(`await tools.exec_command({cmd: "printf next", login: false});`);
  expect(JSON.stringify(requests[2]!.nestedEvidence)).not.toContain("REAL_TAIL");
});

test("cancellation and throwing stale contexts reject late approval without launching", async () => {
  const h = await setup(undefined, {
    gate: true,
    config: { bashGate: { rules: [{ cmd: "touch" }] } },
  });
  const choice = Promise.withResolvers<string>();
  h.ui.select.mockImplementationOnce(() => choice.promise);
  const ctx = h.getContext();
  const pending = h.run(`await tools.exec_command({cmd:'touch forbidden',login:false});`);
  await expect.poll(() => h.ui.select.mock.calls.length).toBe(1);
  await h.session.abort();
  await pending;
  h.session.dispose();
  expect(() => ctx.cwd).toThrow();
  choice.resolve("Allow");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(existsSync(join(h.cwd, "forbidden"))).toBe(false);
});

test("explicit cancellation kills only shells launched by the cancelled script", async () => {
  const h = await setup();
  await h.run(
    `store('unrelated',await tools.exec_command({cmd:'sleep 60',login:false,yield_time_ms:250}));`,
  );
  const pending = h.run(
    `store('cancelled',await tools.exec_command({cmd:'echo $$ > owned.pid; sleep 60',login:false,yield_time_ms:250})); await tools.exec_command({cmd:'sleep 60',login:false,yield_time_ms:30000});`,
  );
  await expect
    .poll(
      () =>
        h.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "exec_command")
          .length,
    )
    .toBe(2);
  const pid = Number(readFileSync(join(h.cwd, "owned.pid"), "utf8").trim());
  expect(
    pid,
    JSON.stringify(h.events.filter((e) => e.type === "tool_execution_end")),
  ).toBeGreaterThan(1);
  await h.session.abort();
  await pending;
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  // Polling a pre-existing session is not ownership: cancellation above leaves it alive.
  const result = await h.run(
    `text(await tools.write_stdin({session_id:load('unrelated').session_id,chars:''}));`,
  );
  expect(result.isError, textOf(result)).toBe(false);
  expect(textOf(result)).toContain('"session_id"');
}, 15000);

test("unhandled script errors cancel pending approvals but preserve finished shell launches", async () => {
  const h = await setup(undefined, {
    gate: true,
    config: { bashGate: { rules: [{ cmd: "touch" }] } },
  });
  const choice = Promise.withResolvers<string>();
  h.ui.select.mockResolvedValueOnce("Allow").mockImplementationOnce(() => choice.promise);
  const pending = h.run(
    `const shell=await tools.exec_command({cmd:'echo $$ > owned.pid; sleep 60',login:false,yield_time_ms:250}); text(shell); await Promise.all([tools.exec_command({cmd:'touch forbidden',login:false}),tools.exec_command({cmd:'printf done',login:false}).then(()=>{throw new Error('stop script');})]);`,
  );
  await expect.poll(() => h.ui.select.mock.calls.length).toBe(2);
  const result = await pending;
  expect(result.isError).toBe(true);
  choice.resolve("Allow");
  expect(() =>
    process.kill(Number(readFileSync(join(h.cwd, "owned.pid"), "utf8").trim()), 0),
  ).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(existsSync(join(h.cwd, "forbidden"))).toBe(false);
});

test.each(["session_tree", "session_start", "session_shutdown"] as const)(
  "native %s invalidates shell and store ownership without restoring resources",
  async (event) => {
    const h = await setup();
    const launched = await h.run(
      `store('old',await tools.exec_command({cmd:'echo $$ > owned.pid; sleep 60',login:false,yield_time_ms:250}));text(load('old'));`,
    );
    expect(launched.isError).toBe(false);
    const pid = Number(readFileSync(join(h.cwd, "owned.pid"), "utf8").trim());
    await h.session.extensionRunner.emit({ type: event, reason: "reload" } as never);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    if (event !== "session_shutdown")
      expect(textOf(await h.run(`text(load('old'));`))).not.toContain("session_id");
  },
);

test("removing codemode restores displaced tools and permits a new read-only selection", async () => {
  const h = await setup();
  h.setTools([]);
  await h.session.extensionRunner.emit({ type: "model_select" } as never);
  expect(h.session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "bash", "edit", "write"]),
  );
  h.setTools(["read", "codemode"]);
  await h.session.extensionRunner.emit({ type: "model_select" } as never);
  expect(h.session.getCallableToolNames()).not.toContain("exec_command");
  expect(h.session.getCallableToolNames()).not.toContain("apply_patch");
  expect(h.session.getCallableToolNames()).toContain("read");
});

test("no Code Mode host is needed, and validation/startup failures reject rather than return values", async () => {
  vi.stubEnv("PATH", "/no-code-mode-host");
  try {
    const h = await setup();
    const result = await h.run(
      `text(await tools.exec_command({cmd:'printf native',shell:'/bin/sh',login:false}));`,
    );
    expect(result.isError, textOf(result)).toBe(false);
    expect(textOf(result)).toContain("native");
    expect(
      (await h.run(`await tools.exec_command({cmd:'printf no',yield_time_ms:-1});`)).isError,
    ).toBe(true);
    expect(
      (
        await h.run(
          `await tools.exec_command({cmd:'printf no',sandbox_permissions:'require_escalated'});`,
        )
      ).isError,
    ).toBe(true);
    expect(
      (await h.run(`await tools.exec_command({cmd:'printf no',shell:'/missing-shell'});`)).isError,
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("context previews follow native prepared loadouts and model/classifier helpers stay out of scope", async () => {
  const h = await setup();
  const prepared = () => h.previewTools().find((t) => t.name === "codemode")!.description;
  expect(prepared()).toBe(
    h.session.agent.state.tools.find((t) => t.name === "codemode")!.description,
  );
  expect(prepared()).toContain("exec_command");
  expect(prepared()).toContain("exit_code");
  const helpers = await h.run(`text({models:typeof models,classify:typeof classify});`);
  expect(textOf(helpers)).toContain('"models":"undefined"');
  expect(textOf(helpers)).toContain('"classify":"undefined"');
  h.setTools([]);
  await h.session.extensionRunner.emit({ type: "model_select" } as never);
  h.setTools(["read", "codemode"]);
  await h.session.extensionRunner.emit({ type: "model_select" } as never);
  expect(prepared()).toBe(
    h.session.agent.state.tools.find((t) => t.name === "codemode")!.description,
  );
  expect(prepared()).not.toContain("tools.exec_command");
  await h.session.setModel(h.runtime.getModel("native-test", "claude")!);
  expect(h.previewTools()).toEqual(h.session.getAllTools());
});

test("native timeout interrupts a script and leaves the next invocation usable", async () => {
  const h = await setup();
  const result = await h.call("codemode", {
    code: '// @options: {"timeout_ms":500}\ntext("entered"); while (true) {}',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(/timed out/i);
  expect(textOf(result)).toContain("entered");
  expect(textOf(await h.run("text(42);"))).toContain("42");
});

for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"] as const) {
  test.each([true, false])(
    `${api} serializes registered native codemode with grammar=%s`,
    async (grammar) => {
      const h = await setup();
      const { normalizeContext } = await import("@earendil-works/pi-ai");
      const { stream } = await import(`@earendil-works/pi-ai/api/${api}`);
      const tools = h.session.agent.state.tools;
      const model = { ...h.session.model!, api, compat: { supportsOpenAIGrammarTools: grammar } };
      const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
      let payload: any;
      const options = {
        apiKey: jwt,
        transport: "sse" as const,
        onPayload(value: unknown) {
          payload = value;
          throw new Error("captured before network");
        },
      };
      await stream(model, normalizeContext({ messages: [], tools }), options).result();
      expect(payload).toBeDefined();
      expect(payload.tools).toHaveLength(1);
      const declaration = payload.tools[0];
      expect(declaration.type).toBe(grammar ? "custom" : "function");
      const tool = api === "openai-completions" ? declaration[declaration.type] : declaration;
      expect(tool.name).toBe("codemode");
      if (grammar) {
        const format = api === "openai-completions" ? tool.format.grammar : tool.format;
        expect(format.syntax).toBe("lark");
        expect(format.definition).not.toContain("PRAGMA_LINE");
      } else expect(tool.parameters.required).toContain("code");
      const initial = payload.tools;
      await stream(
        model,
        normalizeContext({
          systemPrompt: "stable project instructions",
          messages: [
            {
              role: "toolResult",
              toolCallId: "lookup",
              toolName: "codemode",
              content: [{ type: "text", text: "discovered documentation" }],
              isError: false,
              timestamp: 0,
            },
          ],
          tools,
        }),
        options,
      ).result();
      expect(payload.tools).toEqual(initial);
    },
  );
}
