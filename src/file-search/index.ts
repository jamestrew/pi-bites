/**
 * FFF-backed `@` file search
 *
 * Replaces the built-in `@` file autocomplete with FFF (Fast File Finder), but
 * intentionally does not register FFF tools. This extension only overrides the
 * interactive `@` mention provider.
 *
 * Hardened for NFS-backed workspaces by keeping FFF's mutable state outside the
 * repo by default and disabling background watcher/content-index features that
 * are unnecessary for path-only autocomplete.
 *
 * ## Features preserved from the built-in
 *
 * - `applyCompletion` is fully delegated to the built-in provider so
 *   insertion behaviour is identical.
 * - Falls back to the built-in provider for non-`@` tokens and FFF failures.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { FileFinder, type MixedItem } from "@ff-labs/fff-node";

const MENTION_MAX_RESULTS = 20;

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function statePathFor(cwd: string, name: string): string {
  const stateDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || tmpdir();
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(stateDir, `pi-bites-fff-${digest}-${name}.db`);
}

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  let finder: FileFinder | null = null;
  let finderCwd: string | null = null;
  let finderPromise: Promise<FileFinder> | null = null;

  pi.registerFlag("fff-frecency-db", {
    description: "Path to the FFF frecency database (defaults to local tmp)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description: "Path to the FFF query history database (defaults to local tmp)",
    type: "string",
  });

  function resetFinder() {
    if (finder && !finder.isDestroyed) {
      try {
        finder.destroy();
      } catch (error) {
        console.warn("FFF destroy failed", error);
      }
    }
    finder = null;
    finderCwd = null;
  }

  pi.on("session_shutdown", async () => {
    resetFinder();
  });

  function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finder && !finder.isDestroyed && finderCwd === cwd) return Promise.resolve(finder);
    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      resetFinder();

      const frecencyDbPath =
        (pi.getFlag("fff-frecency-db") as string | undefined) ??
        process.env.FFF_FRECENCY_DB ??
        statePathFor(cwd, "frecency");
      const historyDbPath =
        (pi.getFlag("fff-history-db") as string | undefined) ??
        process.env.FFF_HISTORY_DB ??
        statePathFor(cwd, "history");

      const result = FileFinder.create({
        basePath: cwd,
        aiMode: true,
        frecencyDbPath,
        historyDbPath,
        disableWatch: true,
        disableMmapCache: true,
        disableContentIndexing: true,
      });
      if (!result.ok) throw new Error(`FFF init failed: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(15000);
      return finder;
    })()
      .catch((error) => {
        resetFinder();
        throw error;
      })
      .finally(() => {
        finderPromise = null;
      });

    return finderPromise;
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        try {
          const line = lines[cursorLine] ?? "";
          const before = line.slice(0, cursorCol);
          const atPrefix = extractAtPrefix(before);

          // Not an @ token — delegate to the built-in provider.
          if (!atPrefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

          if (options.signal.aborted) return null;

          const query = atPrefix.startsWith('@"') ? atPrefix.slice(2) : atPrefix.slice(1);
          const f = await ensureFinder(cwd);

          if (options.signal.aborted) return null;

          const searchResult = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
          if (!searchResult.ok) {
            console.warn(
              "FFF search failed; falling back to built-in provider",
              searchResult.error,
            );
            resetFinder();
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

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
        } catch (error) {
          if (options.signal.aborted) return null;
          console.warn("FFF mention lookup failed; falling back to built-in provider", error);
          resetFinder();
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
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
