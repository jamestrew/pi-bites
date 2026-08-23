import { isAbsolute, relative } from "node:path";

import { parsePatchActions } from "../patch/parser.js";

function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const displayed = relative(cwd, path);
  return displayed && !displayed.startsWith("..") && !isAbsolute(displayed) ? displayed : path;
}

export function formatApplyPatchSummary(patchText: string, cwd = process.cwd()): string {
  try {
    const actions = parsePatchActions({ text: patchText });
    if (actions.length === 0) return "";
    if (actions.length > 1) return `• Patching ${actions.length} files`;
    const action = actions[0];
    if (!action) return "";
    const target = action.movePath
      ? `${displayPath(action.path, cwd)} → ${displayPath(action.movePath, cwd)}`
      : displayPath(action.path, cwd);
    const verb =
      action.type === "add" ? "Adding" : action.type === "delete" ? "Deleting" : "Patching";
    return `• ${verb} ${target}`;
  } catch {
    return "";
  }
}
