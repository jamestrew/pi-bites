import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  registerGoalRuntimeController,
  type GoalRuntimeOptions,
} from "./goal-runtime-controller.js";

export { __testHooks } from "./runtime-config.js";

export default function (pi: ExtensionAPI, options: GoalRuntimeOptions = {}): void {
  registerGoalRuntimeController(pi, options);
}
