/** Live stock-Pi probe: bun scripts/subagents-route-smoke.ts PROVIDER/MODEL OUTPUT_DIR [adapter-disabled]. */
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
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import registerAdapter from "../packages/ext/codex-adapter/index.js";
import registerGate from "../packages/ext/bash-gate/index.js";
import { createSubagents } from "../packages/ext/subagents/index.js";
import type { SubagentController } from "../packages/ext/subagents/operations.js";
import { EXTENSION_NAMES, type BitesConfig } from "../packages/ext/config.js";

const marker = "V1_RETAINED_278";
const command = "printf subagent-approved";
type Json = Record<string, unknown>;
export interface Operation {
  owner: string;
  name: string;
  args: Json;
  result?: { content: { type: string; text?: string }[]; details?: unknown };
  error?: string;
}
function object(value: unknown): Json {
  return value !== null && typeof value === "object" ? (value as Json) : {};
}
function wire(operation: Operation): Json {
  try {
    return object(
      JSON.parse(operation.result?.content.find((c) => c.type === "text")?.text ?? "{}"),
    );
  } catch {
    return {};
  }
}

/** Check controller results, never the parent's claimed success or echoed input. */
export function checkLifecycle(operations: Operation[], route: string) {
  const parent = operations.filter((o) => o.owner === "parent" && !o.error);
  const spawnIndex = parent.findIndex((o) => o.name === "spawn_agent");
  const spawn = parent[spawnIndex];
  const id = spawn && wire(spawn).agent_id;
  const firstWait = parent.findIndex(
    (o, i) =>
      i > spawnIndex &&
      o.name === "wait_agent" &&
      Array.isArray(o.args.targets) &&
      o.args.targets.includes(id) &&
      object(wire(o).status)[String(id)] !== undefined &&
      wire(o).timed_out === false &&
      "completed" in object(object(wire(o).status)[String(id)]),
  );
  const close = parent.findIndex(
    (o, i) =>
      i > firstWait &&
      o.name === "close_agent" &&
      o.args.target === id &&
      object(o.result?.details).status === "closed",
  );
  const resume = parent.findIndex(
    (o, i) =>
      i > close &&
      o.name === "resume_agent" &&
      o.args.id === id &&
      object(o.result?.details).status === "resumed",
  );
  const send = parent.findIndex(
    (o, i) =>
      i > resume &&
      o.name === "send_input" &&
      o.args.target === id &&
      typeof o.args.message === "string" &&
      !o.args.message.includes(marker) &&
      typeof wire(o).submission_id === "string",
  );
  const recall = parent.findIndex(
    (o, i) =>
      i > send &&
      o.name === "wait_agent" &&
      Array.isArray(o.args.targets) &&
      o.args.targets.includes(id) &&
      wire(o).timed_out === false &&
      typeof object(object(wire(o).status)[String(id)]).completed === "string" &&
      String(object(object(wire(o).status)[String(id)]).completed).includes(marker),
  );
  return {
    sameModelDefaultChild:
      typeof id === "string" &&
      spawn?.args.model === route &&
      spawn.args.agent_type === "default" &&
      String(spawn.args.message).includes(marker) &&
      String(spawn.args.message).includes(command),
    firstCompletion: firstWait > spawnIndex && firstWait >= 0,
    closeResumeSameId: close > firstWait && resume > close && close >= 0,
    recallWithoutReminder: send > resume && recall > send && send >= 0,
    finalClose: parent.some(
      (o, i) =>
        i > recall &&
        recall >= 0 &&
        o.name === "close_agent" &&
        o.args.target === id &&
        object(o.result?.details).status === "closed",
    ),
    parentProgress: operations.some(
      (o) =>
        o.owner === id &&
        o.name === "send_input" &&
        !o.error &&
        typeof wire(o).submission_id === "string" &&
        o.args.target !== id,
    ),
    noOperationErrors: operations.every((o) => !o.error),
  };
}

async function main() {
  const [route, output, scenario] = process.argv.slice(2);
  if (!route?.includes("/") || !output || (scenario && scenario !== "adapter-disabled"))
    throw new Error("Usage: PROVIDER/MODEL OUTPUT_DIR [adapter-disabled]");
  const slash = route.indexOf("/");
  const provider = route.slice(0, slash);
  const modelId = route.slice(slash + 1);
  const directory = resolve(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-route-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  const oldCwd = process.cwd();
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const operations: Operation[] = [];
  const observations: Json[] = [];
  const messages: Json[] = [];
  const notifications: unknown[] = [];
  const approvals: string[] = [];
  const failures: string[] = [];
  const record: Json = {
    route,
    scenario: scenario ?? "normal",
    date: new Date().toISOString(),
    status: "pending",
    operations,
    observations,
    messages,
    notifications,
    approvals,
    failures,
  };
  const save = () =>
    writeFileSync(join(directory, "result.json"), JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  // Include catalog/resource loading and cleanup in the wall-clock bound.
  const timer = setTimeout(() => {
    record.timedOut = true;
    void session?.abort();
  }, 240_000);
  const hardTimer = setTimeout(() => {
    record.status = "failed";
    record.reason = "Hard timeout (270s), cleanup did not settle";
    save();
    rmSync(cwd, { recursive: true, force: true });
    process.exit(1);
  }, 270_000);
  try {
    // Read credentials before redirecting all child settings/config discovery.
    const credential = readStoredCredential(provider);
    const credentials = new InMemoryCredentialStore();
    if (credential) {
      await credentials.modify(provider, async () => credential);
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [provider]: credential }), {
        mode: 0o600,
      });
    }
    const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
    const model = runtime.getModel(provider, modelId);
    if (
      !model ||
      !(await runtime.getAvailable()).some((m) => m.provider === provider && m.id === modelId)
    ) {
      record.status = "unavailable";
      record.reason = "Requested route absent or unauthenticated; no substitute was used.";
      return;
    }
    record.api = model.api;
    const config: { current: BitesConfig } = {
      current: {
        disable: EXTENSION_NAMES.filter(
          (name) =>
            !["bashGate", "subagents", ...(scenario ? [] : ["codexAdapter"])].includes(name),
        ),
        // An explicit empty command constraint matches every parsed command in the existing gate.
        bashGate: {
          mode: "manual",
          rules: [{ cmd: [], reason: "route smoke: approve exact command only" }],
        },
      },
    };
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "pi-bites.json"), JSON.stringify(config.current));
    const settings = { compaction: { enabled: false }, retry: { enabled: false } };
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(cwd);
    let pendingCommand: string | undefined;
    let requests = 0;
    const observe = (pi: ExtensionAPI, owner: string) => {
      pi.on("before_provider_request", (event) => {
        const file = `payload-${++requests}-${owner}.json`;
        writeFileSync(join(directory, file), JSON.stringify(event.payload, null, 2) + "\n", {
          mode: 0o600,
        });
        record.payloads ??= [];
        const payload = object(event.payload);
        const size = (value: unknown) => JSON.stringify(value ?? null).length;
        (record.payloads as unknown[]).push({
          owner,
          file,
          characters: size(payload),
          toolCharacters: size(payload.tools),
          instructionCharacters: size(payload.instructions ?? payload.system),
          historyCharacters: size(payload.input ?? payload.messages),
          tools: Array.isArray(payload.tools)
            ? payload.tools.map((tool) => {
                const definition = object(tool);
                return {
                  name: definition.name ?? object(definition.function).name,
                  type: definition.type,
                };
              })
            : [],
        });
      });
      pi.on("tool_result", (event) => {
        observations.push({
          owner,
          tool: event.toolName,
          input: event.input,
          content: event.content,
          details: event.details,
          isError: event.isError,
        });
      });
      pi.on("message_end", (event) => {
        messages.push({ owner, message: event.message });
        if (event.message.role === "assistant" && event.message.errorMessage)
          failures.push(event.message.errorMessage);
      });
    };
    const observeController = (controller: SubagentController, owner: string) => {
      const capture = controller.capture.bind(controller);
      controller.capture = (...args) => {
        const captured = capture(...args);
        const execute = captured.execute;
        captured.execute = async (name, input, call) => {
          const operation: Operation = { owner, name, args: object(input) };
          operations.push(operation);
          try {
            const result = await execute(name, input, call);
            operation.result = result;
            return result;
          } catch (error) {
            operation.error = String(error);
            throw error;
          }
        };
        return captured;
      };
    };
    const settingsManager = SettingsManager.inMemory(settings);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          const gate = registerGate(pi, config);
          let adapter: ReturnType<typeof registerAdapter> | undefined;
          const controller = createSubagents(
            pi,
            undefined,
            gate,
            () => undefined,
            () => adapter?.getAllowedTools() ?? pi.getActiveTools(),
          );
          observeController(controller, "parent");
          // The embedded child index calls this registration seam before its adapter is registered.
          // Observe real child hooks/operations without replacing sessions, transport, or executors.
          const forChild = controller.forChild.bind(controller);
          controller.forChild = (childPi, child, allowed) => {
            observe(childPi, child.id);
            const childController = forChild(childPi, child, allowed);
            observeController(childController, child.id);
            return childController;
          };
          controller.registerTools();
          if (!scenario) adapter = registerAdapter(pi, config, gate, controller);
          observe(pi, "parent");
          pi.events.on("bites:bash_gate", (event) => {
            pendingCommand = object(event).command as string | undefined;
          });
          for (const name of ["subagents:started", "subagents:completed", "subagents:failed"])
            pi.events.on(name, (data) => notifications.push({ name, data }));
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
    }));
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        select: async () => {
          const candidate = pendingCommand;
          pendingCommand = undefined;
          if (candidate === command) {
            approvals.push(candidate);
            return "Allow";
          }
          failures.push(`Denied unexpected approval: ${candidate}`);
          return "Deny";
        },
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        onTerminalInput: () => () => {},
      } as unknown as ExtensionUIContext,
      onError: (error) => failures.push(JSON.stringify(error)),
    });
    record.activeTools = session.getActiveToolNames();
    const nested = session.getActiveToolNames().includes("exec");
    record.nested = nested;
    await session.prompt(`I explicitly authorize delegation for this smoke test. Use tools, not a simulated transcript.
If Code Mode exec/wait is available, first discover and print COMPLETE help for ALL five nested multi_agent_v1__ tools from ALL_TOOLS before invoking them. Use their actual nested names. Exercise an exec cell with await yield_control() and consume it using the OUTER wait tool; never confuse outer wait with nested wait_agent. Otherwise use the flat lifecycle tools.
Spawn exactly one agent with agent_type "default", model ${JSON.stringify(route)}, and no fork_context. Its task: retain the marker ${marker}; execute EXACTLY ${JSON.stringify(command)} once (exec_command with login:false in Code Mode or bash otherwise), the UI approves only that exact command; send_input a progress message to its parent id from its system prompt; then return a final response. Explicitly tell it to discover complete send_input help first if using Code Mode. Do not run any other commands or use web, filesystem tools, or spawn grandchildren.
Wait for this child's actual completion with wait_agent (repeat on timeout). Then close_agent that id, resume_agent the SAME id, and send_input to that id asking "Recall the retained marker from your previous task and return it, without executing commands." Do NOT repeat the marker in this recall request. Wait for actual completion, inspect its returned marker, and finally close_agent the same id. In Code Mode print every nested result. Finish briefly and report any failure honestly.`);
    record.contextUsage = session.getContextUsage();
    const lifecycle = checkLifecycle(operations, route);
    const childShell = observations.filter((o) => o.owner !== "parent");
    const checks = {
      ...lifecycle,
      approvedExecution:
        approvals.length === 1 &&
        childShell.some(
          (o) =>
            !o.isError &&
            ((o.tool === "bash" &&
              object(o.input).command === command &&
              JSON.stringify(o.content).includes("subagent-approved")) ||
              (["exec", "wait"].includes(String(o.tool)) &&
                Array.isArray(object(o.details).traces) &&
                (object(o.details).traces as unknown[]).some((value) => {
                  const trace = object(value);
                  return (
                    trace.name === "exec_command" &&
                    trace.state === "completed" &&
                    object(trace.input).cmd === command &&
                    JSON.stringify(object(trace.result).content).includes("subagent-approved")
                  );
                }))),
        ),
      independentFinals:
        messages.filter(
          (o) => o.owner === "parent" && object(o.message).customType === "subagent-notification",
        ).length >= 2,
      independentProgress: messages.some(
        (o) => o.owner === "parent" && object(o.message).customType === "subagent-message",
      ),
      childPayload:
        (record.payloads as Json[] | undefined)?.some((p) => p.owner !== "parent") ?? false,
      outerWait:
        !nested ||
        observations.some(
          (o) =>
            o.owner === "parent" &&
            o.tool === "exec" &&
            object(o.details).state === "yielded" &&
            String(object(o.input).code).includes("yield_control") &&
            observations.some(
              (w) =>
                w.owner === "parent" &&
                w.tool === "wait" &&
                !w.isError &&
                object(w.input).cell_id === object(o.details).cellId &&
                object(w.details).state === "result",
            ),
        ),
      completeHelp:
        !nested ||
        observations.some(
          (o) =>
            o.owner === "parent" &&
            o.tool === "exec" &&
            ["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"].every(
              (name) => JSON.stringify(o.content).includes(`multi_agent_v1__${name}`),
            ) &&
            JSON.stringify(o.content).includes("exec tool declaration:"),
        ),
      noToolErrors: observations.every((o) => !o.isError),
    };
    record.checks = checks;
    record.status =
      !record.timedOut && failures.length === 0 && Object.values(checks).every(Boolean)
        ? "passed"
        : "failed";
  } catch (error) {
    record.status = "failed";
    record.reason = String(error);
  } finally {
    try {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } catch (error) {
      record.status = "failed";
      failures.push(`Cleanup: ${error}`);
    }
    if (timer) clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
    process.chdir(oldCwd);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    save();
    rmSync(cwd, { recursive: true, force: true });
    console.log(`${route}: ${record.status}; evidence: ${join(directory, "result.json")}`);
    if (record.status !== "passed") process.exitCode = 1;
  }
}
if (import.meta.main) await main();
