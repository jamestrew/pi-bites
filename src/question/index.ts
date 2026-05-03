// Based on rpiv-ask-user-question by juicesharp — Copyright (c) juicesharp
// MIT License: https://github.com/juicesharp/rpiv-ask-user-question

/**
 * rpiv-ask-user-question — Pi extension
 *
 * Registers the `ask_user_question` tool, which surfaces a structured
 * option selector (plus free-text "Other" fallback) to disambiguate
 * underspecified user requests.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
