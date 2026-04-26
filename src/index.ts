import { registerBashGate } from "./bash-gate.js";
import { registerTokenUsageStatusline } from "./token_usage_statusline.js";
import registerCustomRead from "./read.js";
import registerExplore from "./explore.js";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  registerBashGate(pi);
  registerTokenUsageStatusline(pi);
  registerCustomRead(pi);
  registerExplore(pi);
}
