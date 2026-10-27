import registerCacheDebug from "./cache-debug/index.js";
import registerBashGate from "./bash-gate/index.js";
import registerStatusline from "./statusline.js";
import registerFooter from "./footer/index.js";
import registerTokenCount from "./token-count/index.js";
import registerUsageDashboard from "./usage-dashboard.js";
import registerContext, { type ContextPromptPreview } from "./context.js";
import registerCustomTools from "./tools.js";
import registerFzfFileSearch from "./file-search/index.js";
import registerNotifications from "./notifications.js";
import registerAutoCompaction, { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "./auto-compaction.js";
import registerAutoMode from "./automode/index.js";
import registerPromptNormalization from "./prompt-normalization/index.js";
import registerSpotme from "./spotme/index.js";
import registerInlineReferences from "./inline-references/index.js";
import registerPonytail from "./ponytail/index.js";
import registerSessionTracker from "./session-tracker/index.js";
import { createSubagents } from "./subagents/index.js";
import { getActiveSubagent, getChildCollaboration } from "./subagents/subagent-context.js";
import registerView from "./view/index.js";
import registerCodexAdapter, { type CodexAdapterController } from "./codex-adapter/index.js";
import {
  parseArgs,
  type ExtensionAPI,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, registerBitesCommands, type BitesConfig } from "./config.js";

export default async function (pi: ExtensionAPI) {
  // Pi stores one transformer per extension; our modules share this registration.
  const transformers: MarkdownTransformer[] = [];
  const registerMarkdownTransformer = pi.registerMarkdownTransformer.bind(pi);
  pi.registerMarkdownTransformer = (transformer) => {
    transformers.push(transformer);
    registerMarkdownTransformer((markdown, context) => {
      for (const transform of transformers) {
        try {
          markdown = transform(markdown, context);
        } catch {
          // Match Pi's renderer: one failing transform must not disable the others.
        }
      }
      return markdown;
    });
  };
  const configRef: { current: BitesConfig } = { current: {} };
  const isSubagent = getActiveSubagent() != null;
  const cliArgs = isSubagent ? undefined : parseArgs(process.argv.slice(2));
  const isNonInteractive = process.argv.some((arg) => arg === "--print" || arg === "-p");

  // Load config eagerly at startup to resolve the disable list.
  // Extensions are registered once at load time, so this must happen before
  // the session_start handler fires. process.cwd() matches the session cwd
  // in the vast majority of cases.
  const startupConfig = loadConfig(process.cwd());
  configRef.current = startupConfig;
  const disabled = new Set(startupConfig.disable ?? []);

  pi.on("session_start", async (_event, ctx) => {
    configRef.current = loadConfig(
      ctx.cwd,
      isSubagent
        ? undefined
        : (message) => {
            if (ctx.hasUI) ctx.ui.notify(message, "warning");
            else console.warn(message);
          },
    );
  });

  const autoMode =
    isSubagent || disabled.has("autoMode") ? undefined : registerAutoMode(pi, configRef);
  const bashGate = disabled.has("bashGate") ? undefined : registerBashGate(pi, configRef, autoMode);
  if (!disabled.has("tools")) registerCustomTools(pi);
  // Subagent sessions install the same policy directly at Pi's safe
  // prepare-next-turn seam; ctx.compact() would abort their owning invocation.
  if (!isSubagent && !disabled.has("autoCompaction")) registerAutoCompaction(pi, configRef);
  let codexAdapter: CodexAdapterController | undefined;
  const getAllowedTools = () => codexAdapter?.getAllowedTools() ?? pi.getActiveTools();
  const subagents = disabled.has("subagents")
    ? undefined
    : isSubagent
      ? getChildCollaboration()?.(pi, getAllowedTools)
      : createSubagents(
          pi,
          autoMode,
          bashGate,
          () =>
            configRef.current.disable?.includes("autoCompaction")
              ? undefined
              : (configRef.current.autoCompaction?.thresholdTokens ??
                DEFAULT_AUTO_COMPACTION_THRESHOLD),
          getAllowedTools,
          () => configRef.current.subagents ?? {},
        );
  subagents?.registerTools();
  codexAdapter = disabled.has("codexAdapter")
    ? undefined
    : registerCodexAdapter(
        pi,
        configRef,
        bashGate,
        cliArgs
          ? {
              tools: cliArgs.tools,
              noTools: cliArgs.noTools ? "all" : cliArgs.noBuiltinTools ? "builtin" : undefined,
            }
          : undefined,
      );
  const previewCodexPrompt = codexAdapter?.previewPrompt;

  registerCacheDebug(pi);

  if (isSubagent) return;

  if (!disabled.has("view")) registerView(pi);
  if (!isNonInteractive && !disabled.has("sessionTracker"))
    registerSessionTracker(pi, configRef, autoMode);
  if (!isNonInteractive && !disabled.has("footer")) registerFooter(pi);
  if (!isNonInteractive && !disabled.has("statusline")) registerStatusline(pi, configRef);
  if (!isNonInteractive && !disabled.has("tokenCount")) registerTokenCount(pi);
  if (!isNonInteractive && !disabled.has("usageDashboard")) registerUsageDashboard(pi);
  if (!isNonInteractive && !disabled.has("fzf")) registerFzfFileSearch(pi);
  if (!disabled.has("promptNormalization")) registerPromptNormalization(pi);
  if (!disabled.has("atMentionContext") || !disabled.has("skillPromptReferences"))
    registerInlineReferences(pi, {
      files: !disabled.has("atMentionContext"),
      skillsAndPrompts: !disabled.has("skillPromptReferences"),
    });
  if (!isNonInteractive && !disabled.has("notifications"))
    registerNotifications(pi, configRef, autoMode);
  if (!isNonInteractive && !disabled.has("spotme")) registerSpotme(pi);
  const previewPonytailPrompt = disabled.has("ponytail") ? undefined : registerPonytail(pi);
  const previewSystemPrompt: ContextPromptPreview = (prompt, ctx) => {
    const withCodex =
      previewCodexPrompt?.(prompt, ctx.model, ctx.getSystemPromptOptions()) ?? prompt;
    return previewPonytailPrompt?.(withCodex) ?? withCodex;
  };
  if (!isNonInteractive && !disabled.has("context"))
    registerContext(pi, previewSystemPrompt, codexAdapter?.previewTools);
  registerBitesCommands(pi);
}
