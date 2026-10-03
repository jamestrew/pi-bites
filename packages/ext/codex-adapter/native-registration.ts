import {
  createCodemodeExtension,
  SettingsManager,
  formatSkillsForPrompt,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type CodemodeStoreEntryData,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ToolExecutionContext, OwnedToolDefinition } from "./tool-execution.js";
import type { BashGateController } from "../bash-gate/index.js";
import type { BitesConfig } from "../config.js";
import { snapshotNestedEvidence } from "../automode/tool-evidence.js";
import {
  createAdapterToolState,
  getDelegationTools,
  getNestedTools,
  isAdapterModel,
  reconcileTools,
} from "./activation.js";
import type { CodexAdapterController, CodexPromptPreview } from "./index.js";
import { createApplyPatchTool, isApplyPatchFailure } from "./apply-patch/tool.js";
import { deleteApplyPatchRenderState } from "./apply-patch/render-state.js";
import { createExecCommandTool, ExecCommandError } from "./exec/command-tool.js";
import { createWriteStdinTool } from "./exec/write-stdin-tool.js";
import { createExecSessionManager, type UnifiedExecResult } from "./exec/session-manager.js";
import { pinExecLaunch } from "./exec/launch-context.js";
import { createViewImageTool } from "./view-image/tool.js";
import { getBundledViewImagePath } from "./view-image/binary.js";
import { createWebRunTool, isWebRunAvailable } from "./web-run/tool.js";
import { createNativeRendering } from "./native-rendering.js";
import contract from "./owned-tool-contracts.generated.json" with { type: "json" };

/** Shared parent/SDK-child registration. Pi owns the sandbox, discovery, nested hooks, traces and usage. */
export default function registerNativeAdapter(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
  gate?: BashGateController,
): CodexAdapterController {
  gate?.manageExecCommand();
  const state = createAdapterToolState();
  const sessions = createExecSessionManager();
  const owned = {
    exec_command: createExecCommandTool(sessions),
    write_stdin: createWriteStdinTool(sessions),
    apply_patch: createApplyPatchTool(),
    web_run: createWebRunTool({ getConfig: () => configRef.current.codexAdapter ?? {} }),
    view_image: createViewImageTool(),
  };
  const rendering = createNativeRendering(
    pi,
    owned as unknown as Parameters<typeof createNativeRendering>[1],
  );
  // Pi supersedes its replaceable CLI builtin with this genuine native registration.
  // Forward native /context preparation unchanged; decorate only presentation updates/results.
  let preparedDescriptions: Readonly<Record<string, string>> = {};
  void createCodemodeExtension({ mode: "on", models: false })({
    ...pi,
    registerTool(tool) {
      pi.registerTool({
        ...(rendering.decorate(tool as unknown as ToolDefinition) as typeof tool),
        prepareLoadout(loadout) {
          const prepared = tool.prepareLoadout?.(loadout);
          preparedDescriptions = prepared?.descriptions ?? {};
          return prepared;
        },
      });
    },
  });
  let owner = new AbortController();
  let callable = new Set<string>();
  let active = false;
  const scripts = new Map<
    string,
    {
      shells: Set<number>;
      evidence: Map<string, ReturnType<typeof snapshotNestedEvidence>>;
      dispose(): void;
    }
  >();
  const parents = new Map<string, string>();
  const available = (name: string, ctx: Pick<ExtensionContext, "model">) =>
    name === "web_run"
      ? isWebRunAvailable(ctx.model, configRef.current.codexAdapter ?? {})
      : name === "view_image"
        ? ctx.model?.input.includes("image") === true && !!getBundledViewImagePath()
        : true;
  const enabled = (ctx: Pick<ExtensionContext, "model">) =>
    !configRef.current.disable?.includes("codexAdapter") && isAdapterModel(ctx.model);
  function check(name: string, ctx: ExtensionContext, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!enabled(ctx) || !callable.has(name) || !available(name, ctx))
      throw new Error(`${name} is unavailable`);
  }
  // Native stores are branch-persisted JSON, not live cells. Explicit invalidations clear
  // known keys with Pi's public entry format rather than creating another store/runtime.
  function clearStore(ctx: ExtensionContext) {
    const keys = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "codemode-store") continue;
      const data = entry.data as CodemodeStoreEntryData;
      for (const key of Object.keys(data.set)) keys.add(key);
      for (const key of data.delete) keys.delete(key);
    }
    if (keys.size)
      pi.appendEntry("codemode-store", {
        set: {},
        delete: [...keys],
      } satisfies CodemodeStoreEntryData);
  }
  function invalidate(ctx: ExtensionContext) {
    rendering.reset();
    owner.abort(new Error("Adapter session invalidated"));
    owner = new AbortController();
    for (const script of scripts.values()) script.dispose();
    scripts.clear();
    parents.clear();
    for (const shell of sessions.listSessions()) sessions.terminateSession(shell.id);
    owned.web_run.resetNavigationState();
    clearStore(ctx);
  }
  const shellSchema = Type.Object({
    chunk_id: Type.String(),
    wall_time_seconds: Type.Number(),
    output: Type.String(),
    exit_code: Type.Optional(Type.Number()),
    session_id: Type.Optional(Type.Number()),
    original_token_count: Type.Optional(Type.Number()),
  });
  const definitions: ToolDefinition[] = [];
  type Invocation<P extends TSchema, D> = {
    id: string;
    params: Static<P>;
    signal: AbortSignal;
    onUpdate: AgentToolUpdateCallback<D> | undefined;
    context: ToolExecutionContext;
  };
  // Only validation, stable dependencies and cancellation are shared. Each concrete
  // capability binds its own authorization, error handling and script value below.
  function register<P extends TSchema, D, S>(
    tool: OwnedToolDefinition<P, D, S>,
    outputSchema: TSchema,
    execute: (
      call: Invocation<P, D>,
      activeContext: ExtensionContext,
    ) => Promise<AgentToolResult<D>>,
  ) {
    const definition: ToolDefinition<P, D, S> = {
      ...tool,
      outputSchema,
      parameters: { ...tool.parameters, additionalProperties: false },
      exposure: "direct",
      defaultActive: false,
      async execute(id, params, signal, onUpdate, ctx) {
        const lifetime = AbortSignal.any([owner.signal, ...(signal ? [signal] : [])]);
        check(tool.name, ctx, lifetime);
        if (!Value.Check(definition.parameters, params))
          throw new Error(`Invalid ${tool.name} arguments`);
        const trusted = ctx.isProjectTrusted();
        const result = await execute(
          {
            id,
            params,
            signal: lifetime,
            onUpdate,
            context: {
              cwd: ctx.cwd,
              model: ctx.model,
              modelRegistry: ctx.modelRegistry,
              isProjectTrusted: () => trusted,
            },
          },
          ctx,
        );
        lifetime.throwIfAborted();
        return result;
      },
    };
    definitions.push(definition as ToolDefinition);
    pi.registerTool(definition);
  }
  async function shellValue(
    run: () => Promise<AgentToolResult<UnifiedExecResult>>,
  ): Promise<AgentToolResult<UnifiedExecResult>> {
    let result: AgentToolResult<UnifiedExecResult>;
    try {
      result = await run();
    } catch (error) {
      if (!(error instanceof ExecCommandError)) throw error;
      result = { content: [{ type: "text", text: error.message }], details: error.result };
    }
    return {
      ...result,
      structuredContent: { ...result.details },
      isError: result.details.exit_code !== undefined && result.details.exit_code !== 0,
    };
  }
  register(owned.exec_command, shellSchema, async (call, ctx) => {
    // Capture authorization before the first await; neither the approval nor launch
    // continuation retains the active extension context.
    const authorization = gate?.captureSession(ctx);
    const { id, params, signal, onUpdate, context } = call;
    const execution = pinExecLaunch(params, context);
    const script = scripts.get(parents.get(id) ?? id);
    const remember = (result: AgentToolResult<UnifiedExecResult>) => {
      if (result.details.session_id !== undefined) script?.shells.add(result.details.session_id);
    };
    const run = async () => {
      signal.throwIfAborted();
      if (!callable.has("exec_command")) throw new Error("exec_command is unavailable");
      const result = await shellValue(() =>
        owned.exec_command.execute(
          id,
          params,
          signal,
          (update) => {
            remember(update);
            onUpdate?.(update);
          },
          context,
        ),
      );
      remember(result);
      signal.throwIfAborted();
      return result;
    };
    try {
      return authorization
        ? await authorization.authorize(
            {
              toolCallId: id,
              toolName: "exec_command",
              command: params.cmd,
              execution,
              signal,
              nestedEvidence: script ? [...script.evidence.values()] : undefined,
            },
            run,
          )
        : await run();
    } finally {
      parents.delete(id);
    }
  });
  register(owned.write_stdin, shellSchema, ({ id, params, signal, onUpdate, context }) =>
    shellValue(() => owned.write_stdin.execute(id, params, signal, onUpdate, context)),
  );
  register(
    {
      ...owned.apply_patch,
      description: `${owned.apply_patch.description} Call with {input: patchText}; scripts also accept a raw patch string. Partial failures reject with applied-file and recovery feedback.`,
    },
    Type.Object({
      status: Type.Literal("success"),
      changedFiles: Type.Array(Type.String()),
      createdFiles: Type.Array(Type.String()),
      deletedFiles: Type.Array(Type.String()),
      movedFiles: Type.Array(Type.String()),
      fuzz: Type.Number(),
    }),
    async ({ id, params, signal, onUpdate, context }) => {
      try {
        const result = await owned.apply_patch.execute(id, params, signal, onUpdate, context);
        // No structured value on partial failure: Pi rejects with the existing mutation
        // and recovery feedback, while retaining the concrete renderer details.
        return isApplyPatchFailure(result.details)
          ? { ...result, isError: true }
          : { ...result, structuredContent: { status: "success", ...result.details.result } };
      } finally {
        deleteApplyPatchRenderState(id);
      }
    },
  );
  const webDescription = contract.tools.find((t) => t.name === "web_run")?.description;
  if (!webDescription) throw new Error("Missing web_run contract");
  register(
    {
      ...owned.web_run,
      description: webDescription,
      parameters: Type.Omit(owned.web_run.parameters, ["settings"]),
    },
    Type.String(),
    async ({ id, params, signal, onUpdate, context }) => {
      const result = await owned.web_run.execute(id, params, signal, onUpdate, context);
      return {
        ...result,
        structuredContent: result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      };
    },
  );
  register(
    owned.view_image,
    Type.Object({ image_url: Type.String(), detail: Type.Literal("original") }),
    async ({ id, params, signal, onUpdate, context }) => {
      const result = await owned.view_image.execute(id, params, signal, onUpdate, context);
      const image = result.content.find((c) => c.type === "image");
      if (!image) throw new Error("view_image returned no image");
      return {
        ...result,
        structuredContent: {
          image_url: `data:${image.mimeType};base64,${image.data}`,
          detail: "original",
        },
      };
    },
  );
  const exposures = new Map<string, string>();
  function reconcile(ctx: ExtensionContext) {
    let selected = pi.getActiveTools();
    const initial = !state.selection;
    if (initial) {
      const registered = new Set(pi.getAllTools().map((t) => t.name));
      const settings = pi.getSettings();
      const defaults = settings.defaultTools;
      const resolved = SettingsManager.inMemory(settings).getDefaultTools();
      const explicit =
        defaults?.length === 0 ||
        defaults?.some((name) => !name.startsWith("+") && !name.startsWith("-"));
      const permits = (name: string) =>
        registered.has(name) &&
        defaults?.filter((t) => t === `-${name}` || t === `+${name}`).at(-1) !== `-${name}`;
      if (
        permits("codemode") &&
        (!explicit || resolved?.includes("codemode")) &&
        !selected.includes("codemode")
      )
        selected = [...selected, "codemode"];
      selected = [
        ...selected,
        ...definitions
          .filter((t) => permits(t.name) && !selected.includes(t.name))
          .map((t) => t.name),
      ];
    }
    const next = reconcileTools(selected, enabled(ctx), state);
    const nextActive = enabled(ctx) && next.includes("codemode");
    if (active && !nextActive) invalidate(ctx);
    active = nextActive;
    callable = new Set(
      active ? [...getNestedTools(state)].filter((name) => available(name, ctx)) : [],
    );
    for (const definition of definitions) {
      const exposure = callable.has(definition.name) ? "codemode" : "hidden";
      if (exposures.get(definition.name) === exposure) continue;
      pi.registerTool({ ...definition, exposure });
      exposures.set(definition.name, exposure);
    }
    // SDK tools supplies a registry ceiling, not eager owned declarations. After
    // initial projection, tool search may deliberately activate an allowed declaration.
    pi.setActiveTools([
      ...next,
      ...(initial
        ? []
        : pi.getActiveTools().filter((name) => callable.has(name) && !next.includes(name))),
    ]);
  }
  const preview: CodexPromptPreview = (prompt, model, options) => {
    if (
      !isAdapterModel(model) ||
      configRef.current.disable?.includes("codexAdapter") ||
      !(options.selectedTools ?? pi.getActiveTools()).includes("codemode")
    )
      return prompt;
    if (callable.has("exec_command")) {
      const original = "Use the read tool to load a skill's file";
      const replacement =
        "Use `codemode` to load a skill's file through `tools.exec_command` and emit its contents with `text(result.output)`";
      if (prompt.includes("<available_skills>")) prompt = prompt.replace(original, replacement);
      else {
        const skills = formatSkillsForPrompt(options.skills ?? []);
        if (skills) prompt += `\n\n${skills.replace(original, replacement)}`;
      }
    }
    return callable.has("web_run") ? `${prompt}\n\n${webGuidance}` : prompt;
  };
  pi.registerMarkdownTransformer((markdown, ctx) =>
    ctx.messageType === "assistant" ? owned.web_run.transformCitations(markdown) : markdown,
  );
  pi.on("tool_call", (event, ctx) => {
    const parentId = event.parentToolCallId;
    const script = scripts.get(parentId ?? "");
    if (script && parentId) {
      script.evidence.set(
        event.toolCallId,
        snapshotNestedEvidence({
          cellId: parentId,
          callId: event.toolCallId,
          name: event.toolName,
          cwd: ctx.cwd,
          input: event.input,
          state: "running",
        }),
      );
      // Match the retired trace collector's 128-call retention ceiling.
      if (script.evidence.size > 128) {
        const oldest = script.evidence.keys().next().value;
        if (oldest !== undefined) script.evidence.delete(oldest);
      }
    }
    if (event.parentToolCallId && event.toolName === "exec_command")
      parents.set(event.toolCallId, event.parentToolCallId);
    if (event.toolName !== "codemode") return;
    const shells = new Set<number>();
    const signal = ctx.signal;
    const cancel = () => {
      for (const id of shells) sessions.terminateSession(id);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    scripts.set(event.toolCallId, {
      shells,
      evidence: new Map(),
      dispose: () => signal?.removeEventListener("abort", cancel),
    });
  });
  pi.on("tool_execution_end", (event) => {
    const evidence = scripts.get(event.parentToolCallId ?? "")?.evidence;
    const trace = evidence?.get(event.toolCallId);
    if (trace && evidence)
      evidence.set(
        event.toolCallId,
        snapshotNestedEvidence({
          ...trace,
          cwd: typeof trace.cwd === "string" ? trace.cwd : undefined,
          state: event.isError ? "error" : "completed",
          result: event.result as AgentToolResult<unknown>,
        }),
      );
  });
  pi.on("tool_result", (event) => {
    parents.delete(event.toolCallId);
    if (event.toolName !== "codemode") return;
    const script = scripts.get(event.toolCallId);
    script?.dispose();
    scripts.delete(event.toolCallId);
    if (script)
      return {
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          reviewEvidence: [...script.evidence.values()],
        },
      };
  });
  pi.on("agent_end", () => {
    rendering.reset();
    for (const script of scripts.values()) script.dispose();
    scripts.clear();
    parents.clear();
  });
  pi.on("session_start", (_e, ctx) => {
    invalidate(ctx);
    reconcile(ctx);
  });
  pi.on("session_tree", (_e, ctx) => {
    invalidate(ctx);
    reconcile(ctx);
  });
  pi.on("model_select", (_e, ctx) => {
    owned.web_run.resetNavigationState();
    reconcile(ctx);
  });
  pi.on("turn_start", (_e, ctx) => reconcile(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    reconcile(ctx);
    const systemPrompt = preview(event.systemPrompt, ctx.model, {
      ...event.systemPromptOptions,
      selectedTools: pi.getActiveTools(),
    });
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    invalidate(ctx);
    callable.clear();
    pi.setActiveTools(reconcileTools(pi.getActiveTools(), false, state));
    await sessions.shutdown();
  });
  return {
    previewPrompt: preview,
    previewTools: (tools) =>
      pi.getActiveTools().includes("codemode")
        ? tools.map((tool) => ({
            ...tool,
            description: preparedDescriptions[tool.name] ?? tool.description,
          }))
        : tools,
    getAllowedTools: () => getDelegationTools(pi.getActiveTools(), state),
  };
}

const webGuidance = `web_run searches the internet and images and opens, clicks or finds text in pages. Before browsing, read its full operation, citation and word-limit guidance with text(await describeTool("web_run")) in codemode; rediscover it if no longer in context. Discovery does not grant credentials. Browse when explicitly asked to search, browse, verify or look something up; obey requests not to browse. Browse for changing information, substantial time or money recommendations, precise quotes/links/attribution, referenced material not supplied, uncertain/niche/emerging facts, and high-stakes medical/legal/financial accuracy. When unsure, browse. Check local code first for OpenAI product questions; if browsing is needed use official OpenAI sources unless requested otherwise.`;
