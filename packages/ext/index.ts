import registerBashGate from "./bash-gate/index.js";
import registerRtk from "./rtk.js";
import registerStatusline from "./statusline.js";
import registerFooter from "./footer/index.js";
import registerTokenCount from "./token-count/index.js";
import registerUsageDashboard from "./usage-dashboard.js";
import registerCustomTools from "./tools.js";
import registerExplore from "./explore/index.js";
import registerFzfFileSearch from "./file-search/index.js";
import registerAtMentionContext from "./at-mention-context/index.js";
import registerTodo from "./todo/index.js";
import registerQuestion from "./question/index.js";
import registerNotifications from "./notifications.js";
import registerCheckpoints from "./checkpoints.js";
import registerPromptNormalization from "./prompt-normalization/index.js";
import registerSpotme from "./spotme/index.js";
import registerInlineReferences from "./inline-references/index.js";
import registerTau from "./tau/index.js";
import registerPonytail from "./ponytail/index.js";
import registerSessionTracker from "./session-tracker/index.js";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, registerBitesCommands, type SnacksConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const configRef: { current: SnacksConfig } = { current: {} };
  const isExploreSubagent = process.env.PI_BITES_SUBAGENT === "explore";
  const isNonInteractive = process.argv.some((arg) => arg === "--print" || arg === "-p");

  // Load config eagerly at startup to resolve the disable list.
  // Extensions are registered once at load time, so this must happen before
  // the session_start handler fires. process.cwd() matches the session cwd
  // in the vast majority of cases.
  const startupConfig = loadConfig(process.cwd());
  const disabled = new Set(startupConfig.disable ?? []);

  pi.on("session_start", async (_event, ctx) => {
    configRef.current = loadConfig(ctx.cwd);
  });

  if (!disabled.has("bashGate")) registerBashGate(pi, configRef);
  if (!disabled.has("rtk")) registerRtk(pi);

  if (isExploreSubagent) return;

  if (!isNonInteractive && !disabled.has("tau")) registerTau(pi, configRef);

  if (!isNonInteractive && !disabled.has("footer")) registerFooter(pi);
  if (!isNonInteractive && !disabled.has("statusline")) registerStatusline(pi, configRef);
  if (!isNonInteractive && !disabled.has("tokenCount")) registerTokenCount(pi);
  if (!isNonInteractive && !disabled.has("usageDashboard")) registerUsageDashboard(pi);
  if (!disabled.has("tools")) registerCustomTools(pi);
  if (!disabled.has("explore")) registerExplore(pi, configRef);
  if (!isNonInteractive && !disabled.has("fzf")) registerFzfFileSearch(pi);
  if (!disabled.has("promptNormalization")) registerPromptNormalization(pi);
  if (!disabled.has("atMentionContext")) registerAtMentionContext(pi);
  if (!isNonInteractive && !disabled.has("todo")) registerTodo(pi);
  if (!isNonInteractive && !disabled.has("question")) registerQuestion(pi);
  if (!isNonInteractive && !disabled.has("notifications")) registerNotifications(pi, configRef);
  if (!disabled.has("checkpoints")) registerCheckpoints(pi, configRef);
  if (!isNonInteractive && !disabled.has("spotme")) registerSpotme(pi);
  if (!disabled.has("inlineReferences") && !disabled.has("slashSkillAutocomplete"))
    registerInlineReferences(pi);
  if (!disabled.has("ponytail")) registerPonytail(pi, configRef);
  if (!isNonInteractive && !disabled.has("sessionTracker")) registerSessionTracker(pi);
  registerBitesCommands(pi);
}
