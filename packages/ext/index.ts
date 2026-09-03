import registerBashGate from "./bash-gate/index.js";
import registerRtk from "./rtk.js";
import registerStatusline from "./statusline.js";
import registerFooter from "./footer/index.js";
import registerTokenCount from "./token-count/index.js";
import registerUsageDashboard from "./usage-dashboard.js";
import registerContext, { type ContextPromptPreview } from "./context.js";
import registerCustomTools from "./tools.js";
import registerFzfFileSearch from "./file-search/index.js";
import registerAtMentionContext from "./at-mention-context/index.js";
import registerNotifications from "./notifications.js";
import registerAutoCompaction, { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "./auto-compaction.js";
import registerAutoMode from "./automode/index.js";
import registerPromptNormalization from "./prompt-normalization/index.js";
import registerSpotme from "./spotme/index.js";
import registerInlineReferences from "./inline-references/index.js";
import registerPonytail from "./ponytail/index.js";
import registerSessionTracker from "./session-tracker/index.js";
import registerSubagents from "./subagents/index.js";
import { getActiveSubagent } from "./subagents/subagent-context.js";
import registerView from "./view/index.js";
import registerGoal from "./goal/index.js";
import registerCodexAdapter from "./codex-adapter/index.js";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, registerBitesCommands, type BitesConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const configRef: { current: BitesConfig } = { current: {} };
  const isSubagent = getActiveSubagent() != null;
  const isNonInteractive = process.argv.some((arg) => arg === "--print" || arg === "-p");

  // Load config eagerly at startup to resolve the disable list.
  // Extensions are registered once at load time, so this must happen before
  // the session_start handler fires. process.cwd() matches the session cwd
  // in the vast majority of cases.
  const startupConfig = loadConfig(process.cwd());
  configRef.current = startupConfig;
  const disabled = new Set(startupConfig.disable ?? []);

  pi.on("session_start", async (_event, ctx) => {
    configRef.current = loadConfig(ctx.cwd);
  });

  const autoMode =
    isSubagent || disabled.has("autoMode") ? undefined : registerAutoMode(pi, configRef);
  const bashGate = disabled.has("bashGate") ? undefined : registerBashGate(pi, configRef, autoMode);
  if (!disabled.has("rtk")) registerRtk(pi);
  if (!disabled.has("tools")) registerCustomTools(pi);
  // Subagent sessions install the same policy directly at Pi's safe
  // prepare-next-turn seam; ctx.compact() would abort their owning invocation.
  if (!isSubagent && !disabled.has("autoCompaction")) registerAutoCompaction(pi, configRef);
  const previewCodexPrompt = disabled.has("codexAdapter")
    ? undefined
    : registerCodexAdapter(pi, configRef);

  if (isSubagent) return;

  if (!disabled.has("goal")) registerGoal(pi);
  if (!disabled.has("view")) registerView(pi);
  if (!isNonInteractive && !disabled.has("sessionTracker"))
    registerSessionTracker(pi, configRef, autoMode);
  if (!disabled.has("subagents"))
    registerSubagents(pi, autoMode, bashGate, () =>
      configRef.current.disable?.includes("autoCompaction")
        ? undefined
        : (configRef.current.autoCompaction?.thresholdTokens ?? DEFAULT_AUTO_COMPACTION_THRESHOLD),
    );

  if (!isNonInteractive && !disabled.has("footer")) registerFooter(pi);
  if (!isNonInteractive && !disabled.has("statusline")) registerStatusline(pi, configRef);
  if (!isNonInteractive && !disabled.has("tokenCount")) registerTokenCount(pi);
  if (!isNonInteractive && !disabled.has("usageDashboard")) registerUsageDashboard(pi);
  if (!isNonInteractive && !disabled.has("fzf")) registerFzfFileSearch(pi);
  if (!disabled.has("promptNormalization")) registerPromptNormalization(pi);
  if (!disabled.has("atMentionContext")) registerAtMentionContext(pi);
  if (!isNonInteractive && !disabled.has("notifications"))
    registerNotifications(pi, configRef, autoMode);
  if (!isNonInteractive && !disabled.has("spotme")) registerSpotme(pi);
  if (!disabled.has("inlineReferences") && !disabled.has("slashSkillAutocomplete"))
    registerInlineReferences(pi);
  const previewPonytailPrompt = disabled.has("ponytail") ? undefined : registerPonytail(pi);
  const previewSystemPrompt: ContextPromptPreview = (prompt, ctx) => {
    const withCodex =
      previewCodexPrompt?.(prompt, ctx.model, ctx.getSystemPromptOptions()) ?? prompt;
    return previewPonytailPrompt?.(withCodex) ?? withCodex;
  };
  if (!isNonInteractive && !disabled.has("context")) registerContext(pi, previewSystemPrompt);
  registerBitesCommands(pi);
}
