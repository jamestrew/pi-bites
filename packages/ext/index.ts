import registerBashGate from "./bash-gate/index.js";
import registerRtk from "./rtk.js";
import registerStatusline from "./statusline.js";
import registerFooter from "./footer/index.js";
import registerTokenCount from "./token-count/index.js";
import registerUsageDashboard from "./usage-dashboard.js";
import registerContext from "./context.js";
import registerCachePadding from "./cache-padding/index.js";
import registerCustomTools from "./tools.js";
import registerFzfFileSearch from "./file-search/index.js";
import registerAtMentionContext from "./at-mention-context/index.js";
import registerTodo from "./todo/index.js";
import registerQuestion from "./question/index.js";
import registerNotifications from "./notifications.js";
import registerCheckpoints from "./checkpoints.js";
import registerAutoCompaction from "./auto-compaction.js";
import registerAutoMode from "./automode/index.js";
import registerPromptNormalization from "./prompt-normalization/index.js";
import registerSpotme from "./spotme/index.js";
import registerInlineReferences from "./inline-references/index.js";
import registerPonytail from "./ponytail/index.js";
import registerSessionTracker from "./session-tracker/index.js";
import registerSubagents from "./subagents/index.js";
import registerView from "./view/index.js";
import registerGoal from "./goal/index.js";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, registerBitesCommands, type BitesConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const configRef: { current: BitesConfig } = { current: {} };
  const isSubagent = process.env.PI_BITES_SUBAGENT != null;
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
  if (!disabled.has("bashGate")) registerBashGate(pi, configRef, autoMode);
  if (!disabled.has("rtk")) registerRtk(pi);
  if (!disabled.has("tools")) registerCustomTools(pi);
  if (!disabled.has("autoCompaction")) registerAutoCompaction(pi, configRef);

  if (isSubagent) return;

  if (!disabled.has("goal")) registerGoal(pi);
  if (!disabled.has("view")) registerView(pi);
  if (!isNonInteractive && !disabled.has("sessionTracker")) registerSessionTracker(pi, configRef);
  if (!isNonInteractive && !disabled.has("subagents")) registerSubagents(pi, configRef, autoMode);

  if (!isNonInteractive && !disabled.has("footer")) registerFooter(pi);
  if (!isNonInteractive && !disabled.has("statusline")) registerStatusline(pi, configRef);
  if (!isNonInteractive && !disabled.has("tokenCount")) registerTokenCount(pi);
  if (!isNonInteractive && !disabled.has("usageDashboard")) registerUsageDashboard(pi);
  if (!isNonInteractive && !disabled.has("fzf")) registerFzfFileSearch(pi);
  if (!disabled.has("promptNormalization")) registerPromptNormalization(pi);
  if (!disabled.has("atMentionContext")) registerAtMentionContext(pi);
  if (!isNonInteractive && !disabled.has("todo")) registerTodo(pi);
  if (!isNonInteractive && !disabled.has("question")) registerQuestion(pi);
  if (!isNonInteractive && !disabled.has("notifications"))
    registerNotifications(pi, configRef, autoMode);
  if (!disabled.has("checkpoints")) registerCheckpoints(pi, configRef);
  if (!isNonInteractive && !disabled.has("spotme")) registerSpotme(pi);
  if (!disabled.has("inlineReferences") && !disabled.has("slashSkillAutocomplete"))
    registerInlineReferences(pi);
  const previewPonytailPrompt = disabled.has("ponytail")
    ? undefined
    : registerPonytail(pi, configRef);
  const cachePadding = disabled.has("cachePadding") ? undefined : registerCachePadding(pi);
  const previewSystemPrompt = (prompt: string) => {
    const withPonytail = previewPonytailPrompt?.(prompt) ?? prompt;
    return cachePadding?.systemPrompt(withPonytail) ?? withPonytail;
  };
  if (!isNonInteractive && !disabled.has("context"))
    registerContext(pi, previewSystemPrompt, cachePadding?.tools);
  registerBitesCommands(pi);
}
