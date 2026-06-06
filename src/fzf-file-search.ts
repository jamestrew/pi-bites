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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { PathIndex } from "./file-search/path-index.js";
import { searchPaths } from "./file-search/path-matcher.js";

const MENTION_MAX_RESULTS = 20;

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@[^\s]*)$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  const pathIndex = new PathIndex();

  pi.on("session_shutdown", async () => {
    pathIndex.clear();
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

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
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
