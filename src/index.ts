import registerBashGate from "./bash-gate.js";
import registerStatusline from "./statusline.js";
import registerTokenCount from "./token-count.js";
import registerCustomTools from "./tools.js";
import registerExplore from "./explore.js";
import registerFzfFileSearch from "./fzf-file-search.js";
import registerTodo from "./todo/index.js";
import registerQuestion from "./question/index.js";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, registerBitesCommands, type SnacksConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const configRef: { current: SnacksConfig } = { current: {} };

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
  if (!disabled.has("statusline")) registerStatusline(pi, configRef);
  if (!disabled.has("tokenCount")) registerTokenCount(pi);
  if (!disabled.has("tools")) registerCustomTools(pi);
  if (!disabled.has("explore")) registerExplore(pi, configRef);
  if (!disabled.has("fzf")) registerFzfFileSearch(pi);
  if (!disabled.has("todo")) registerTodo(pi);
  if (!disabled.has("question")) registerQuestion(pi);
  registerBitesCommands(pi);
}
