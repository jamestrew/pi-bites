/**
 * fd-powered `@` file search
 *
 * Replaces the built-in `@` file autocomplete with a lightweight per-session
 * path cache. The cache is process-local and loaded on the first `@` request
 * with `fd` instead of maintaining native or persistent finder state.
 *
 * ## Features preserved from the built-in
 *
 * - `applyCompletion` is fully delegated to the built-in provider so
 *   insertion behaviour is identical.
 * - Falls back to the built-in provider for non-`@` tokens.
 */

import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { FileFrecency } from "./frecency/index.js";
import { PathIndex } from "./path-index/index.js";
import { searchPaths } from "./path-matcher/index.js";

const MENTION_MAX_RESULTS = 20;
const FRECENCY_BOOST = 100;

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@[^\s]*)$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function toCwdRelativePath(cwd: string, path: string): string | null {
  const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return relativePath;
}

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  const pathIndex = new PathIndex();
  const frecency = new FileFrecency();

  pi.on("session_shutdown", async () => {
    pathIndex.clear();
    await frecency.save();
  });

  pi.on("agent_end", (_event, ctx) => {
    void (async () => {
      try {
        await frecency.load(ctx.cwd);
        const paths = await pathIndex.refresh(ctx.cwd);
        if (frecency.pruneMissing(paths) > 0) await frecency.save();
      } catch (error) {
        console.warn("File path cache refresh failed", error);
      }
    })();
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;

    const path = event.input.path;
    if (typeof path !== "string") return;

    const relativePath = toCwdRelativePath(ctx.cwd, path);
    if (!relativePath) return;

    void (async () => {
      try {
        await frecency.load(ctx.cwd);
        frecency.visit(relativePath);
        await frecency.save();
      } catch (error) {
        console.warn("File frecency visit failed", error);
      }
    })();
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    await frecency.load(cwd);

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);
        const atPrefix = extractAtPrefix(before);

        // Not an @ token — delegate to the built-in provider.
        if (!atPrefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        if (options.signal.aborted) return null;

        const query = atPrefix.slice(1);

        let paths: string[];
        try {
          paths = await pathIndex.getPaths(cwd, options.signal);
        } catch (error) {
          if (options.signal.aborted) return null;
          console.warn("File path cache load failed; falling back to built-in provider", error);
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        if (options.signal.aborted) return null;

        const items: AutocompleteItem[] = searchPaths(query, paths, {
          limit: MENTION_MAX_RESULTS,
          boost: (path) => Math.log1p(frecency.score(path)) * FRECENCY_BOOST,
        }).map((result) => {
          const pathParts = result.path.split("/");
          return {
            value: buildAtCompletionValue(result.path),
            label: pathParts.at(-1) ?? result.path,
            description: result.path,
          };
        });

        if (items.length === 0) return null;
        return { prefix: atPrefix, items };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        if (prefix.startsWith("@") && item.description) {
          frecency.visit(item.description);
          void frecency.save();
        }

        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
