/**
 * FFF-backed `@` file search
 *
 * Replaces the built-in `@` file autocomplete with FFF (Fast File Finder) —
 * a Rust-native, SIMD-accelerated file finder with frecency ranking.
 *
 * ## How it differs from the old fzf-based implementation
 *
 * The previous version ran `fd` per keystroke and scored results in JS.
 * This version uses FFF's native `mixedSearch`, which is pre-indexed,
 * frecency-ranked (files you access often rank higher), and git-aware —
 * no subprocess spawn per query.
 *
 * ## Features preserved from the built-in
 *
 * - `applyCompletion` is fully delegated to the built-in provider so
 *   insertion behaviour is identical.
 * - Falls back to the built-in provider for non-`@` tokens.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { FileFinder } from "@ff-labs/fff-node";
import type { MixedItem } from "@ff-labs/fff-node";

const MENTION_MAX_RESULTS = 20;

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  let finder: FileFinder | null = null;
  let finderCwd: string | null = null;
  let finderPromise: Promise<FileFinder> | null = null;

  pi.on("session_shutdown", async () => {
    if (finder && !finder.isDestroyed) {
      finder.destroy();
      finder = null;
      finderCwd = null;
    }
  });

  function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finder && !finder.isDestroyed && finderCwd === cwd) return Promise.resolve(finder);
    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      if (finder && !finder.isDestroyed) {
        finder.destroy();
        finder = null;
        finderCwd = null;
      }

      const result = FileFinder.create({ basePath: cwd, aiMode: true });
      if (!result.ok) throw new Error(`FFF init failed: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(15000);
      return finder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    // Warm up the finder eagerly so the first `@` keystroke is instant
    try {
      await ensureFinder(cwd);
    } catch {
      // Non-fatal — finder will be retried on first query
    }

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);
        const atPrefix = extractAtPrefix(before);

        // Not an @ token — delegate to the built-in provider
        if (!atPrefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        if (options.signal.aborted) return null;

        const query = atPrefix.startsWith('@"') ? atPrefix.slice(2) : atPrefix.slice(1);

        let f: FileFinder;
        try {
          f = await ensureFinder(cwd);
        } catch {
          // FFF unavailable — fall back to built-in
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        if (options.signal.aborted) return null;

        const searchResult = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
        if (!searchResult.ok) return null;

        const items: AutocompleteItem[] = searchResult.value.items
          .slice(0, MENTION_MAX_RESULTS)
          .map((mixed: MixedItem) => {
            if (mixed.type === "directory") {
              return {
                value: buildAtCompletionValue(mixed.item.relativePath),
                label: mixed.item.dirName,
                description: mixed.item.relativePath,
              };
            }
            return {
              value: buildAtCompletionValue(mixed.item.relativePath),
              label: mixed.item.fileName,
              description: mixed.item.relativePath,
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
