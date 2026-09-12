/** Live stock-Pi route probe. Run with bun scripts/code-mode-route-smoke.ts PROVIDER/MODEL OUTPUT_DIR. */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  readStoredCredential,
  ModelRuntime,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import registerAdapter from "../packages/ext/codex-adapter/index.js";
import registerGate from "../packages/ext/bash-gate/index.js";

const [route, output, scenario] = process.argv.slice(2);
if (
  !route?.includes("/") ||
  !output ||
  (scenario && !["explicit", "implicit", "coding"].includes(scenario))
)
  throw new Error("Usage: PROVIDER/MODEL OUTPUT_DIR [explicit|implicit|coding]");
const separator = route.indexOf("/");
const provider = route.slice(0, separator);
const modelId = route.slice(separator + 1);
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-route-"));
const command = "printf code-mode-approved";
const record: Record<string, unknown> = {
  route,
  date: new Date().toISOString(),
  status: "pending",
  scenario: scenario ?? "cutover",
};
const save = () =>
  writeFileSync(join(directory, "result.json"), JSON.stringify(record, null, 2) + "\n");
try {
  const credentials = new InMemoryCredentialStore();
  const credential = readStoredCredential(provider);
  if (credential) await credentials.modify(provider, async () => credential);
  const modelRuntime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    record.status = "unavailable";
    record.reason = "Model is absent from the configured Pi catalog; no substitute route was used.";
  } else {
    record.api = model.api;
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    let pendingCommand: string | undefined;
    let approvals = 0;
    let requests = 0;
    const observations: unknown[] = [];
    const usage: unknown[] = [];
    const failures: string[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          const config = {
            current: { bashGate: { rules: [{ cmd: "printf", reason: "route smoke approval" }] } },
          };
          registerAdapter(pi, config, registerGate(pi, config));
          pi.events.on("bites:bash_gate", (event: unknown) => {
            pendingCommand = (event as { command?: string }).command;
          });
          pi.on("before_provider_request", (event) => {
            const payload = event.payload as {
              tools?: unknown[];
              instructions?: unknown;
              input?: unknown;
            };
            const tools = payload.tools;
            writeFileSync(
              join(directory, `payload-${requests + 1}.json`),
              JSON.stringify(payload, null, 2) + "\n",
            );
            writeFileSync(
              join(directory, `tools-${++requests}.json`),
              JSON.stringify(tools ?? [], null, 2) + "\n",
            );
          });
          pi.on("tool_result", (event) => {
            observations.push({
              tool: event.toolName,
              input: event.input,
              content: event.content,
              details: event.details,
              isError: event.isError,
            });
          });
        },
      ],
    });
    await resourceLoader.reload();
    writeFileSync(
      join(cwd, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNkZGJmYGAAAAAqAAjaWO5EAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      resourceLoader,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, 120_000);
    try {
      await session.bindExtensions({
        mode: "rpc",
        uiContext: {
          select: async () => {
            const allow = pendingCommand === command;
            pendingCommand = undefined;
            if (allow) approvals++;
            return allow ? "Allow" : "Deny";
          },
          notify: () => {},
          setStatus: () => {},
        } as unknown as ExtensionUIContext,
        onError: (error) => failures.push(String(error)),
      });
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant")
          usage.push(event.message.usage);
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.errorMessage
        )
          failures.push(event.message.errorMessage);
      });
      record.activeTools = session.getActiveToolNames();
      const discoveryPrompts: Record<string, string> = {
        explicit:
          "Search the web for the official OpenAI API tool-search documentation and give a short answer with a source link.",
        implicit:
          "What is the latest stable version of Bun today? Give its release date and a source link.",
        coding:
          "Use the available tools to compute the sum of the squares of integers 1 through 10 in JavaScript, then state the result.",
      };
      await session.prompt(
        discoveryPrompts[scenario ?? ""] ??
          `Run this Code Mode smoke exercise using the available exec/wait tools. First execute text(6 * 7). Then execute text("before-yield"); await yield_control(); text("after-yield"); and use wait to consume its result. Next execute text(await tools.exec_command({cmd:${JSON.stringify(command)},login:false})); exactly once; the test UI approves that exact command. Finally execute image(await tools.view_image({path:"image.png"})); to emit the supplied local image. Do not use web or other commands. Finish with one sentence describing any failure.`,
      );
      record.usage = usage;
      record.contextUsage = session.getContextUsage();
      record.approvals = approvals;
      record.requests = requests;
      record.observations = observations;
      record.failures = failures;
      record.timedOut = timedOut;
      const results = observations as {
        tool: string;
        content: { type: string; text?: string }[];
        isError?: boolean;
      }[];
      record.checks = {
        normal: results.some((r) => r.tool === "exec" && r.content.some((c) => c.text === "42")),
        wait: results.some(
          (r) => r.tool === "wait" && r.content.some((c) => c.text === "after-yield"),
        ),
        approval:
          approvals === 1 &&
          results.some((r) => r.content.some((c) => c.text?.includes("code-mode-approved"))),
        image: results.some((r) => r.content.some((c) => c.type === "image")),
      };
      if (scenario) {
        const serialized = JSON.stringify(observations);
        const discoveryIndex = results.findIndex((r) =>
          r.content.some(
            (c) => c.text?.includes("exec tool declaration:") && c.text.includes("web_run"),
          ),
        );
        const webIndex = (observations as { details?: unknown }[]).findIndex((r) =>
          JSON.stringify(r.details ?? {}).includes('"name":"web_run"'),
        );
        record.checks =
          scenario === "coding"
            ? {
                noWebHelp: discoveryIndex < 0,
                noWebCall: webIndex < 0,
                computed: serialized.includes("385"),
              }
            : { discovered: discoveryIndex >= 0, webAfterHelp: webIndex > discoveryIndex };
      }
      record.status =
        !timedOut &&
        failures.length === 0 &&
        !results.some((r) => r.isError) &&
        Object.values(record.checks as object).every(Boolean)
          ? "passed"
          : "failed";
    } finally {
      clearTimeout(timer);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }
} catch (error) {
  record.status = "failed";
  record.reason = error instanceof Error ? error.message : String(error);
} finally {
  save();
  rmSync(cwd, { recursive: true, force: true });
}
console.log(`${route}: ${record.status}; evidence: ${join(directory, "result.json")}`);
if (record.status !== "passed") process.exitCode = 1;
