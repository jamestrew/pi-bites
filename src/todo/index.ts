// Based on rpiv-todo by juicesharp — Copyright (c) juicesharp
// MIT License: https://github.com/juicesharp/rpiv-todo

/**
 * Registers the `todo` tool, `/todos` slash command, and the five lifecycle
 * hooks that manage branch-replay state reconstruction and the TodoOverlay
 * persistent widget.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME, registerTodoTool, registerTodosCommand, reconstructTodoState } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

export default function (pi: ExtensionAPI) {
  // Todo overlay widget — constructed lazily at the first session_start with UI.
  let todoOverlay: TodoOverlay | undefined;

  registerTodoTool(pi);
  registerTodosCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    reconstructTodoState(ctx);
    if (ctx.hasUI) {
      todoOverlay ??= new TodoOverlay();
      todoOverlay.setUICtx(ctx.ui);
      todoOverlay.update();
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    reconstructTodoState(ctx);
    todoOverlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructTodoState(ctx);
    todoOverlay?.update();
  });

  pi.on("session_shutdown", async () => {
    todoOverlay?.dispose();
    todoOverlay = undefined;
  });

  // Reads getTodos() at render time; do NOT call reconstructTodoState here
  // (branch is stale — message_end runs after tool_execution_end).
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    todoOverlay?.update();
  });
}
