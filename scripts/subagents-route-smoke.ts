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

const marker = "V2_RETAINED_352";
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

/** Queue-only mail is persisted without emitting a streaming message_end event. */
export function checkMailbox(history: readonly unknown[]) {
  const mail = history.map(object).filter((message) => message.customType === "subagent-message");
  return {
    independentFinals:
      mail.filter((message) => object(message.details).completion === "completed").length === 2,
    independentProgress: mail.some((message) => !object(message.details).completion),
  };
}

/** Check controller results, never the parent's claimed success or echoed input. */
export function checkLifecycle(operations: Operation[], route: string) {
  const parent = operations.filter((o) => o.owner === "parent" && !o.error);
  const spawnIndex = parent.findIndex((o) => o.name === "spawn_agent");
  const spawn = parent[spawnIndex];
  const task = spawn && wire(spawn).task_name;
  const listedCompletion = (o: Operation, markerText?: string) => {
    const agents = wire(o).agents;
    return (
      o.name === "list_agents" &&
      Array.isArray(agents) &&
      agents.some((value) => {
        const agent = object(value);
        const completed = object(agent.agent_status).completed;
        return (
          agent.agent_name === task &&
          typeof completed === "string" &&
          (!markerText || completed.includes(markerText))
        );
      })
    );
  };
  const first = parent.findIndex((o, i) => i > spawnIndex && listedCompletion(o));
  const interrupt = parent.findIndex(
    (o, i) =>
      i > first &&
      o.name === "interrupt_agent" &&
      o.args.target === task &&
      "completed" in object(wire(o).previous_status),
  );
  const followup = parent.findIndex(
    (o, i) =>
      i > interrupt &&
      o.name === "followup_task" &&
      o.args.target === task &&
      typeof o.args.message === "string" &&
      !o.args.message.includes(marker) &&
      o.result?.content[0]?.text === "",
  );
  const recall = parent.findIndex((o, i) => i > followup && listedCompletion(o, marker));
  return {
    sameModelDefaultChild:
      typeof task === "string" &&
      spawn?.args.model === route &&
      spawn.args.agent_type === "default" &&
      String(spawn.args.message).includes(marker) &&
      String(spawn.args.message).includes(command),
    firstCompletion: first > spawnIndex && first >= 0,
    interruptRetainsTask: interrupt > first && first >= 0,
    recallWithoutReminder: followup > interrupt && interrupt >= 0 && recall > followup,
    mailboxWait: parent.some(
      (o) =>
        o.name === "wait_agent" &&
        typeof wire(o).message === "string" &&
        wire(o).timed_out === false &&
        !Object.hasOwn(o.args, "targets"),
    ),
    parentProgress: operations.some(
      (o) =>
        o.owner === task &&
        o.name === "send_message" &&
        !o.error &&
        o.args.target === "/root" &&
        o.result?.content[0]?.text === "",
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
        const file = `payload-${++requests}.json`;
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
            observe(childPi, child.taskName ?? child.id);
            const childController = forChild(childPi, child, allowed);
            observeController(childController, child.taskName ?? child.id);
            return childController;
          };
          controller.registerTools();
          if (!scenario) adapter = registerAdapter(pi, config, gate);
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
Use the six DIRECT subagent tools, including when Code Mode is active. Do not discover collaboration via ALL_TOOLS or call nested collaboration functions.
Spawn exactly one agent with task_name "probe", agent_type "default", model ${JSON.stringify(route)}, and fork_turns "none". Its task: retain marker ${marker}; execute EXACTLY ${JSON.stringify(command)} once (exec_command with login:false in Code Mode or bash otherwise), the UI approves only that exact command; send_message a progress message to /root; then return a final response WITHOUT spelling out the marker yet. Do not run other commands, web/filesystem tools, or spawn grandchildren.
Use wait_agent to observe mailbox activity and list_agents to verify actual completion (repeat waits on timeout or progress-only updates). Then interrupt_agent the settled task to verify its previous completed status. Use followup_task on the SAME task asking "Recall the retained marker from your previous task and return it, without executing commands." Do NOT repeat the marker in this recall request. Wait for completion mail, then use list_agents to verify the completed answer contains the retained marker. Finish briefly and report failures honestly.`);
    record.contextUsage = session.getContextUsage();
    record.parentHistory = session.messages;
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
      ...checkMailbox(session.messages),
      childPayload:
        (record.payloads as Json[] | undefined)?.some((p) => p.owner !== "parent") ?? false,
      directPayloads:
        (record.payloads as Json[] | undefined)?.every((p) => {
          const names = (p.tools as Json[]).map((t) => t.name);
          return (
            [
              "spawn_agent",
              "send_message",
              "followup_task",
              "wait_agent",
              "interrupt_agent",
              "list_agents",
            ].every((name) => names.includes(name)) &&
            !names.some((name) => String(name).startsWith("multi_agent_v1__"))
          );
        }) ?? false,
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
