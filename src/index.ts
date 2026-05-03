import { registerBashGate } from "./bash-gate.js";
import { registerStatusline } from "./statusline.js";
import registerCustomRead from "./read.js";
import registerExplore from "./explore.js";
import registerFzfFileSearch from "./fzf-file-search.js";
import registerTodo from "./todo/index.js";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, type SnacksConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const configRef: { current: SnacksConfig } = { current: {} };

  pi.on("session_start", async (_event, ctx) => {
    configRef.current = loadConfig(ctx.cwd);
  });

  registerBashGate(pi, configRef);
  registerStatusline(pi, configRef);
  registerCustomRead(pi);
  registerExplore(pi, configRef);
  registerFzfFileSearch(pi);
  registerTodo(pi);
}
