import { randomBytes } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "../shared/terminal-text.js";
import { fingerprint, object, type Fingerprints } from "./fingerprints.js";

const ENTRY = "pi-bites:cache-debug";
const LIMITS =
  "Logical pre-transport request inspection only; later handlers may change the body. Internal retries, WebSocket continuation and fallback are not wire capture. Provider/proxy cache lifetime is unknown; elapsed time does not suppress capture.";

type Observation = {
  sessionId: string;
  generation: number;
  sequence: number;
  provider: string;
  model: string;
  api: string;
  timestamp: number;
  monotonic: number;
  fingerprints: Fingerprints;
};
type Baseline = Observation & { usage: Usage; usageSource: "provider-confirmed" | "normalized" };
type InFlight = Observation & {
  responseId?: string;
  terminal?: { responseId: string; usagePresent: boolean };
};
type Anomaly = {
  version: 1;
  sessionId: string;
  generation: number;
  resetReason: string;
  previous: Omit<Baseline, "monotonic">;
  current: Omit<Baseline, "monotonic">;
  logicalRequestGapMs: number;
  ttlPolicyMs: number | null;
  inputComparison: {
    previousCount: number;
    currentCount: number;
    commonPrefix: number;
    firstDifference: number | null;
    historicalInputChanged: boolean;
  };
  missedTokens: number;
  estimatedExcessCost: number | null;
  observations: string[];
  coverage: string[];
};

function safeUsage(usage: Partial<Usage> | undefined): usage is Usage {
  return (
    !!usage &&
    !!usage.cost &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) &&
    [
      usage.cost.input,
      usage.cost.output,
      usage.cost.cacheRead,
      usage.cost.cacheWrite,
      usage.cost.total,
    ].every((value) => Number.isFinite(value) && value >= 0)
  );
}

// Keep only normalized numeric usage/cost fields, never arbitrary message metadata.
function copyUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

export default function registerCacheDebug(pi: ExtensionAPI): void {
  let enabled = true;
  let active = true;
  let generation = 0;
  let sequence = 0;
  let key = randomBytes(32);
  let sessionId: string | undefined;
  let rewriteId: string | undefined;
  let resetReason = "startup";
  let support = "not yet observed";
  let coverage = "awaiting a comparable request";
  let baseline: Baseline | undefined;
  let inFlight: InFlight | undefined;
  let ambiguous = false;
  let cacheActivity = false;
  let pending: Anomaly[] = [];

  function reset(reason: string) {
    generation++;
    key = randomBytes(32);
    baseline = undefined;
    inFlight = undefined;
    pending = [];
    ambiguous = false;
    cacheActivity = false;
    resetReason = reason;
    coverage = "awaiting a comparable request";
  }
  function limit(reason: string) {
    baseline = undefined;
    cacheActivity = false;
    coverage = reason;
    resetReason = reason;
  }
  function sync(ctx: ExtensionContext): boolean {
    const before = generation;
    const id = ctx.sessionManager.getSessionId();
    const rewrite = ctx.sessionManager
      .getBranch()
      .slice()
      .reverse()
      .find(
        (entry) =>
          entry.type === "context_edit" ||
          entry.type === "compaction" ||
          entry.type === "branch_summary",
      )?.id;
    if (sessionId !== id) {
      reset("session replacement");
      sessionId = id;
    } else if (rewriteId !== rewrite) {
      reset("context rewrite");
    }
    rewriteId = rewrite;
    return generation !== before;
  }

  pi.on("session_start", (event, ctx) => {
    active = true;
    unsubscribeTurnEnd ??= pi.on("turn_end", flush);
    reset(event.reason);
    sessionId = undefined;
    sync(ctx);
    resetReason = event.reason;
    support = "not yet observed";
  });
  pi.on("session_shutdown", () => {
    active = false;
    // A registered turn_end opts into Pi's context-refresh boundary even if it
    // returns nothing. Remove it before disposal so late turns cannot refresh state.
    unsubscribeTurnEnd?.();
    unsubscribeTurnEnd = undefined;
    reset("session shutdown");
    sessionId = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!active) return;
    reset("branch navigation");
    sync(ctx);
    resetReason = "branch navigation";
  });
  pi.on("session_compact", (_event, ctx) => {
    if (!active) return;
    reset("successful compaction");
    sync(ctx);
    resetReason = "successful compaction";
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !active) return;
    const timestamp = Date.now();
    const monotonic = performance.now();
    sync(ctx);
    if (inFlight || ambiguous) {
      inFlight = undefined;
      ambiguous = true;
      limit("ambiguous logical requests/retries");
      return;
    }
    const activeSessionId = sessionId;
    const model = ctx.model;
    if (!activeSessionId || !model) {
      support = "no active model/session";
      limit(support);
      ambiguous = true;
      return;
    }
    try {
      const fingerprints = fingerprint(event.payload, key);
      support = "supported logical request";
      inFlight = {
        sessionId: activeSessionId,
        generation,
        sequence: ++sequence,
        provider: model.provider,
        model: model.id,
        api: String(model.api),
        timestamp,
        monotonic,
        fingerprints,
      };
    } catch (error) {
      // Error strings are ours, not payload/provider content.
      const reasons = [
        "unsupported logical payload",
        "inspection bounds exceeded",
        "unsupported payload value",
        "incomplete logical request history",
      ];
      support =
        error instanceof Error && reasons.includes(error.message)
          ? error.message
          : "unsupported payload";
      limit(support);
      ambiguous = true;
    }
    return undefined;
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!enabled || !active || !inFlight) return;
    if (
      event.provider !== inFlight.provider ||
      event.model !== inFlight.model ||
      event.api !== inFlight.api
    ) {
      inFlight = undefined;
      ambiguous = true;
      limit("provider stream identity mismatch");
      return;
    }
    const raw = event.data;
    if (
      !object(raw) ||
      !["response.created", "response.completed", "response.done", "response.incomplete"].includes(
        String(raw.type),
      )
    )
      return;
    if (sync(ctx)) return;
    const response = raw.response;
    if (
      !object(response) ||
      typeof response.id !== "string" ||
      response.id.length > 256 ||
      (inFlight.responseId !== undefined && inFlight.responseId !== response.id) ||
      inFlight.terminal
    ) {
      inFlight = undefined;
      ambiguous = true;
      limit("ambiguous terminal response identity");
      return;
    }
    inFlight.responseId = response.id;
    if (raw.type === "response.created") return;
    const usage = response.usage;
    const details = object(usage) ? usage.input_tokens_details : undefined;
    inFlight.terminal = {
      responseId: response.id,
      usagePresent:
        object(usage) &&
        object(details) &&
        [usage.input_tokens, usage.output_tokens, details.cached_tokens].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
        ),
    };
  });

  pi.on("message_end", (event, ctx) => {
    if (!enabled || !active || event.message.role !== "assistant") return;
    sync(ctx);
    const request = inFlight;
    inFlight = undefined;
    if (ambiguous) {
      ambiguous = false;
      return;
    }
    const message = event.message as AssistantMessage;
    if (!request) {
      limit("assistant response without a supported observation");
      return;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      limit("failed/aborted response");
      return;
    }
    if (
      (request.terminal !== undefined && !request.terminal.usagePresent) ||
      (request.responseId !== undefined && request.responseId !== message.responseId) ||
      message.provider !== request.provider ||
      message.model !== request.model ||
      message.api !== request.api ||
      !safeUsage(message.usage)
    ) {
      limit("missing usage or ambiguous response correlation");
      return;
    }
    const current: Baseline = {
      ...request,
      usage: copyUsage(message.usage),
      usageSource: request.terminal ? "provider-confirmed" : "normalized",
    };
    // The terminal identity is used for correlation only, not persisted.
    delete (current as InFlight).terminal;
    delete (current as InFlight).responseId;
    const previous = baseline;
    baseline = current;
    const hadActivity = cacheActivity;
    cacheActivity ||= current.usage.cacheRead > 0 || current.usage.cacheWrite > 0;
    coverage = previous
      ? "comparable usage observed"
      : "baseline established; first request is not a miss";
    if (current.usageSource === "normalized")
      coverage += "; normalized usage only; omitted cache metrics may appear as zero";
    if (!previous) return;
    const gap = current.monotonic - previous.monotonic;
    if (!Number.isFinite(gap) || gap < 0) {
      limit("logical request timing unavailable/discontinuous");
      return;
    }
    const usage = current.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const previousTokens =
      previous.usage.input + previous.usage.cacheRead + previous.usage.cacheWrite;
    if (promptTokens === 0 || (usage.cacheRead === 0 && usage.cacheWrite === 0 && !hadActivity)) {
      coverage = "no reported cache activity; no miss inferred";
      return;
    }
    const missedTokens = Math.max(0, Math.min(previousTokens, promptTokens) - usage.cacheRead);
    const paidTokens = usage.input + usage.cacheWrite;
    const paidRate = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
    const readRate =
      usage.cacheRead > 0
        ? usage.cost.cacheRead / usage.cacheRead
        : (ctx.modelRegistry.find(message.provider, message.model)?.cost.cacheRead ?? NaN) /
          1_000_000;
    const pricing = ctx.modelRegistry.find(message.provider, message.model);
    const estimate = pricing ? missedTokens * Math.max(0, paidRate - readRate) : NaN;
    const estimatedExcessCost = Number.isFinite(estimate) ? estimate : null;
    if (missedTokens <= 1024 || (missedTokens < 20_000 && (estimatedExcessCost ?? 0) < 0.1)) return;
    const a = previous.fingerprints;
    const b = current.fingerprints;
    let commonPrefix = 0;
    while (
      commonPrefix < Math.min(a.input.length, b.input.length) &&
      a.input[commonPrefix] === b.input[commonPrefix]
    )
      commonPrefix++;
    const historicalInputChanged = commonPrefix < a.input.length;
    const observations: string[] = [];
    if (a.instructions !== b.instructions) observations.push("Leading instructions changed.");
    if (a.tools !== b.tools) observations.push("Tool declarations changed.");
    if (a.key !== b.key) observations.push("Cache key changed.");
    if (a.options !== b.options) observations.push("Fixed request options changed.");
    if (historicalInputChanged) observations.push("Historical input prefix changed.");
    if (
      previous.provider !== current.provider ||
      previous.model !== current.model ||
      previous.api !== current.api
    )
      observations.push("Provider/model changed.");
    if (observations.length === 0)
      observations.push(
        "No request-prefix mutation observed; transport/provider cause remains unresolved.",
      );
    if (pending.length >= 8) {
      limit("pending anomaly bounds exceeded (8 per turn)");
      return;
    }
    const { monotonic: _previousClock, ...previousSummary } = previous;
    const { monotonic: _currentClock, ...currentSummary } = current;
    pending.push({
      version: 1,
      sessionId: current.sessionId,
      generation,
      resetReason,
      previous: previousSummary,
      current: currentSummary,
      logicalRequestGapMs: gap,
      ttlPolicyMs: null,
      inputComparison: {
        previousCount: a.input.length,
        currentCount: b.input.length,
        commonPrefix,
        firstDifference: historicalInputChanged ? commonPrefix : null,
        historicalInputChanged,
      },
      missedTokens,
      estimatedExcessCost,
      observations,
      coverage: [
        LIMITS,
        "Lost reuse/cost is an estimate, not proof of cause or billing.",
        "Provider-converted input may include moving cache markers; prefix changes do not identify the responsible extension.",
        ...(previous.usageSource === "normalized" || current.usageSource === "normalized"
          ? [
              "Pi normalized usage only: omitted provider cache metrics may appear as zero; a miss is not confirmed.",
            ]
          : []),
      ],
    });
  });

  function flush(_event: unknown, ctx: ExtensionContext) {
    if (!enabled || !active) return;
    sync(ctx);
    if (inFlight || ambiguous) {
      inFlight = undefined;
      ambiguous = false;
      limit("turn ended without reliable response correlation");
    }
    const entries = pending;
    pending = [];
    for (const entry of entries) {
      if (entry.sessionId === sessionId && entry.generation === generation)
        pi.appendEntry(ENTRY, entry);
    }
  }

  let unsubscribeTurnEnd: (() => void) | undefined = pi.on("turn_end", flush);

  pi.registerCommand("cache-debug", {
    description: "Control local rolling prompt-cache diagnostics: on|off|status",
    handler: async (args, ctx) => {
      const arg = args.trim() || "status";
      if (arg !== "on" && arg !== "off" && arg !== "status") {
        ctx.ui.notify("Usage: /cache-debug on|off|status", "warning");
        return;
      }
      sync(ctx);
      if (arg !== "status") {
        enabled = arg === "on";
        reset(`capture ${arg}`);
      }
      ctx.ui.notify(
        [
          `Cache debug: ${enabled ? "on" : "off"} (local only, no uploads).`,
          `Observation: ${support}. Generation ${generation}; reset: ${resetReason}.`,
          `Baseline: ${baseline ? "established" : "cold"}; ${coverage}. Pending: ${pending.length}/8.`,
          "TTL suppression: disabled; actual provider/proxy cache lifetime is unknown.",
          LIMITS,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerEntryRenderer<Anomaly>(ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data || (data.version as number) !== 1) return undefined;
    const title =
      theme.bold("Cache") +
      theme.fg("accent", ` estimated lost reuse ${data.missedTokens.toLocaleString()} tokens`);
    const details = expanded
      ? [
          ...data.observations,
          `Logical request gap: ${Math.round(data.logicalRequestGapMs)} ms; local TTL filter: ${data.ttlPolicyMs == null ? "none" : `${data.ttlPolicyMs / 60_000}m`}.`,
          `Generation ${data.generation}; reset: ${data.resetReason}; requests ${data.previous.sequence} → ${data.current.sequence}.`,
          `Input prefix: ${data.inputComparison.commonPrefix}/${data.inputComparison.previousCount} prior items.`,
          ...JSON.stringify(data, null, 2).split("\n"),
        ]
      : [...data.observations];
    if (!expanded) {
      let hint = "ctrl+o to expand";
      try {
        hint = keyHint("app.tools.expand", "to expand");
      } catch {
        /* Print mode. */
      }
      details.push(`(${hint})`);
    }
    return new Text(
      [title, "", ...details.map((line) => theme.fg("dim", sanitizeSingleLine(line)))].join("\n"),
      0,
      0,
    );
  });
}
