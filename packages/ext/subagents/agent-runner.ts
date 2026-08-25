/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
} from "./agent-types.js";
import { createChildMessageAgent } from "./child-message-agent.js";
import { extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { snapshotParent, type ParentSnapshot } from "./parent-snapshot.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { Type, type Static } from "typebox";
import * as Value from "typebox/value";
import { preloadSkills } from "./skill-loader.js";
import { runAsSubagent } from "./subagent-context.js";
import { createSubagentEventBus } from "./subagent-event-bus.js";
import { isThinkingLevel, type SubagentType, type ThinkingLevel } from "./types.js";
import type { AssistantUsage } from "./usage.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WAIT_AGENT: "WaitAgent",
  MESSAGE_AGENT: "MessageAgent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name =
    base === "index.ts" || base === "index.js"
      ? basename(dirname(extPath))
      : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names` for diagnostics. `bareNames`
 * contains only name entries: path entries must match their resolved path, otherwise
 * another discovered copy with the same generic canonical name (for example, two
 * worktree copies of `ext/index.ts`) would also be admitted.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; bareNames: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const bareNames = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      const name = entry.toLowerCase();
      names.add(name);
      bareNames.add(name);
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, bareNames, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<Api> | undefined,
  availableModels: Model<Api>[],
  configModel?: string,
): Model<Api> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);
      const found = availableModels.find(
        (candidate) => candidate.provider === provider && candidate.id === modelId,
      );
      if (found) return found;
    }
  }
  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end" | "call";
  toolName: string;
  arguments?: Record<string, unknown>;
}

function dispatchToolActivity(
  event: AgentSessionEvent,
  onToolActivity: ((activity: ToolActivity) => void) | undefined,
): void {
  if (event.type === "tool_execution_start") {
    onToolActivity?.({ type: "start", toolName: event.toolName });
  } else if (event.type === "tool_execution_end") {
    onToolActivity?.({ type: "end", toolName: event.toolName });
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    for (const part of event.message.content) {
      if (part.type === "toolCall") {
        onToolActivity?.({
          type: "call",
          toolName: part.name,
          arguments: part.arguments,
        });
      }
    }
  }
}

export const SUBAGENT_METADATA_ENTRY = "pi-bites:subagent";

export const SubagentMetadataSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  type: Type.String(),
  title: Type.String(),
  bashGatePolicy: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("prompt")])),
});

export type SubagentMetadata = Static<typeof SubagentMetadataSchema>;

export function parseSubagentMetadata(value: unknown): SubagentMetadata | undefined {
  return Value.Check(SubagentMetadataSchema, value) ? value : undefined;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<Api>;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Fixed transport to the session that spawned this child. */
  messageParent: (message: string) => boolean;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: AssistantUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: {
    reason: "manual" | "threshold" | "overflow";
    tokensBefore: number;
  }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getAssistantUsage(message: AssistantMessage): AssistantUsage {
  const { usage } = message;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    provider: message.provider,
    model: message.model,
    timestamp: message.timestamp,
  };
}

function getToolCallName(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  if (typeof value.name === "string") return value.name;
  return typeof value.toolName === "string" ? value.toolName : "unknown";
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text: string | undefined;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") text = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text = (text ?? "") + event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      text = extractText(event.message.content).trim();
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the terminal assistant message without falling back to earlier turns. */
function getTerminalAssistantMessage(
  session: AgentSession,
  invocationStart: number,
): AssistantMessage | undefined {
  for (let index = session.messages.length - 1; index >= invocationStart; index--) {
    const msg = session.messages[index];
    if (msg?.role === "assistant") return msg;
  }
  return undefined;
}

function getTerminalAssistantText(
  session: AgentSession,
  invocationStart: number,
): string | undefined {
  const message = getTerminalAssistantMessage(session, invocationStart);
  return message ? extractText(message.content).trim() : undefined;
}

/** Pi resolves session.prompt() after terminal provider errors; preserve their actual cause. */
function throwTerminalAssistantError(session: AgentSession, invocationStart: number): void {
  const message = getTerminalAssistantMessage(session, invocationStart);
  if (message?.stopReason === "error") {
    throw new Error(message.errorMessage?.trim() || "Agent failed without provider error details.");
  }
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    void session.abort();
    return () => {};
  }
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(
  sessionDir: string | undefined,
  cwd: string,
): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/"))
    return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export async function runAgent(
  parentContext: ParentSnapshot | ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const parent =
    "systemPrompt" in parentContext
      ? parentContext
      : snapshotParent(parentContext, options.inheritContext === true);
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? parent.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = parent.systemPrompt;

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  // Nulling excludes under isolated also suppresses the orphaned-exclude warning —
  // isolation is an intentional override, not a misconfiguration.
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const skills = options.isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(
        agentConfig.name,
        agentConfig.memory,
        configCwd,
      );
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt(
      { ...fallback, name: type },
      effectiveCwd,
      env,
      parentSystemPrompt,
      extras,
    );
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    options.isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  const keepBareNames = extensionsSpec?.bareNames ?? new Set<string>();
  const keepPaths = new Set(extensionsSpec?.paths.map((path) => resolve(path)) ?? []);
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`.
  // It's only needed when we're neither loading everything without excludes
  // (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.map((e) => extensionCanonicalName(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const name = extensionCanonicalName(e.path);
              if (excludeNames.has(name)) return false; // exclude wins
              return loadAll || keepBareNames.has(name) || keepPaths.has(resolve(e.path));
            }),
          };
        };

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    eventBus: createSubagentEventBus(options.pi.events),
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await runAsSubagent(type, () => loader.reload());

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.map((e) => extensionCanonicalName(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  // Resolve model: explicit option > config.model > parent model
  const model =
    options.model ?? resolveDefaultModel(parent.model, parent.availableModels, agentConfig?.model);

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const configuredThinking = options.thinkingLevel ?? agentConfig?.thinking;
  const thinkingLevel = isThinkingLevel(configuredThinking) ? configuredThinking : undefined;

  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // Enumerate extension-registered tool names from the loaded resource loader.
  // Extensions populate `extension.tools` during `loader.reload()` and the set
  // is stable afterwards — `bindExtensions` does not register new tools.
  //
  // Opt-in flip: when any `ext:` selector is present, extension tools become an
  // explicit allowlist — a loaded extension not named by a selector contributes
  // no tools (its handlers still ran), and `ext:foo/bar` narrows `foo` to `bar`.
  const extensionToolNames: string[] = [];
  if (!noExtensions) {
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canon = extensionCanonicalName(extension.path);
      if (optInActive && !extNames.has(canon)) continue;
      const narrowed = narrowing.get(canon);
      for (const toolName of extension.tools.keys()) {
        if (narrowed && !narrowed.has(toolName)) continue;
        extensionToolNames.push(toolName);
      }
    }
  }

  // Build the master tool allowlist applied at session construction.
  // pi-mono's `allowedToolNames` gates BOTH registration and the initial active
  // set, so listing the exact final set here means the session is correctly
  // scoped from the first instant — no post-construction narrowing required.
  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [
    ...new Set([
      ...[...toolNames, ...extensionToolNames].filter((t) => {
        if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
        if (disallowedSet?.has(t)) return false;
        if (builtinToolNameSet.has(t)) return true;
        // Reached only for extension tools. The extension set was already filtered
        // at the loader (extensionsOverride / noExtensions) and at enumeration
        // (`ext:` opt-in flip), so any extension tool in `extensionToolNames` is allowed.
        return !noExtensions;
      }),
      SUBAGENT_TOOL_NAMES.MESSAGE_AGENT,
    ]),
  ];

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir();
  const sessionManager = agentConfig?.persistSession
    ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir)
    : SessionManager.inMemory(effectiveCwd);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  for (const [providerId, provider] of parent.providers) {
    modelRuntime.registerProvider(providerId, provider);
  }

  const sessionOpts: NonNullable<Parameters<typeof createAgentSession>[0]> = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRuntime,
    model,
    tools: allowedTools,
    customTools: [
      createChildMessageAgent(SUBAGENT_TOOL_NAMES.MESSAGE_AGENT, options.messageParent),
    ],
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  sessionManager.appendCustomEntry(SUBAGENT_METADATA_ENTRY, {
    agentId: options.agentId,
    type,
    title: agentConfig?.displayName ?? agentConfig?.name ?? type,
    bashGatePolicy: agentConfig?.bashGatePolicy,
  } satisfies SubagentMetadata);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  let turnCount = 0;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    dispatchToolActivity(event, options.onToolActivity);
    if (event.type === "message_end" && event.message.role === "assistant") {
      options.onAssistantUsage?.(getAssistantUsage(event.message));
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext && parent.parentContext) {
    effectivePrompt = parent.parentContext + prompt;
  }

  const invocationStart = session.messages.length;
  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  throwTerminalAssistantError(session, invocationStart);
  const responseText =
    collector.getText() ?? getTerminalAssistantText(session, invocationStart) ?? "";
  return { responseText, session };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: AssistantUsage) => void;
    onCompaction?: (info: {
      reason: "manual" | "threshold" | "overflow";
      tokensBefore: number;
    }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents =
    options.onToolActivity || options.onAssistantUsage || options.onCompaction
      ? session.subscribe((event: AgentSessionEvent) => {
          dispatchToolActivity(event, options.onToolActivity);
          if (event.type === "message_end" && event.message.role === "assistant") {
            options.onAssistantUsage?.(getAssistantUsage(event.message));
          }
          if (event.type === "compaction_end" && !event.aborted && event.result) {
            options.onCompaction?.({
              reason: event.reason,
              tokensBefore: event.result.tokensBefore,
            });
          }
        })
      : () => {};

  const invocationStart = session.messages.length;
  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  throwTerminalAssistantError(session, invocationStart);
  return collector.getText() ?? getTerminalAssistantText(session, invocationStart) ?? "";
}

/**
 * Send a steering message to a running subagent.
 * The message is consumed after the current assistant response's tool-call batch.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${getToolCallName(c)}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
