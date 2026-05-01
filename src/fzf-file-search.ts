/**
 * fzf-style `@` file search
 *
 * Replaces the built-in `@` file autocomplete with a proper fzf-style scorer.
 *
 * ## How it differs from the built-in
 *
 * The built-in passes the query to `fd` as a regex pattern, so only substring
 * matches reach the scorer. This extension runs `fd` with no pattern (returning
 * all files) and scores entirely client-side, enabling true subsequence /
 * fuzzy matches — e.g. `@mts` can surface `main.ts`.
 *
 * Scoring uses a rolling Smith-Waterman DP:
 *   - Consecutive match run bonus (grows with run length)
 *   - Word-boundary bonus after `/`, `-`, `_`, `.`, space
 *   - CamelCase transition bonus
 *   - Start-of-string bonus
 *   - Gap penalty per skipped character
 * Basename is scored first (10× weight); full-path score is the tiebreaker.
 *
 * ## Features preserved from the built-in
 *
 * - Scoped queries: `@src/foo` narrows `fd` to the `src/` directory, then
 *   fuzzy-scores `foo` against results relative to that base.
 * - Quoted paths: `@"path with spaces"` is handled correctly.
 * - Home-dir expansion in scoped queries: `@~/proj/foo`.
 * - `applyCompletion` and `shouldTriggerFileCompletion` are fully delegated to
 *   the built-in provider so insertion behaviour is identical.
 *
 * ## Extras
 *
 * - No `--max-results` cap — avoids silently hiding files in large repos.
 * - `@@query` opts into `--no-ignore`, surfacing gitignored files while still
 *   excluding `.git` and `node_modules`. Composes with scoped queries:
 *   `@@src/foo` searches all files under `src/`.
 * - Slash-separated queries where the directory part doesn't exist on disk
 *   (e.g. `@./scr/fzf` when `.scratch/` is the real dir) use per-segment
 *   scoring: each `/`-delimited query chunk is matched independently against
 *   the corresponding path segment, so `scr` can match `.scratch` and `fzf`
 *   can match `fzf-file-search.ts`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers ported from CombinedAutocompleteProvider in autocomplete.ts
// ---------------------------------------------------------------------------

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) return null;
  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) return null;
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) return null;
  return text.slice(quoteStart);
}

/** Extract the full @... token before the cursor, including quoted variants. */
function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix?.startsWith('@"')) return quotedPrefix;

  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

function parsePathPrefix(prefix: string): {
  rawPrefix: string;
  isAtPrefix: boolean;
  isQuotedPrefix: boolean;
} {
  if (prefix.startsWith('@"'))
    return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
  if (prefix.startsWith('"'))
    return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
  if (prefix.startsWith("@"))
    return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
  return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
  path: string,
  options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
  const needsQuotes = options.isQuotedPrefix || path.includes(" ");
  const atSign = options.isAtPrefix ? "@" : "";
  if (!needsQuotes) return `${atSign}${path}`;
  return `${atSign}"${path}"`;
}

function expandHomePath(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

/**
 * If the raw query contains a `/`, split at the last slash and return the
 * directory part as a new fd base directory plus the remaining query fragment.
 * Returns null when there is no slash or the resolved directory doesn't exist.
 */
function resolveScopedFuzzyQuery(
  rawQuery: string,
  basePath: string,
): { baseDir: string; query: string; displayBase: string } | null {
  const normalizedQuery = toDisplayPath(rawQuery);
  const slashIndex = normalizedQuery.lastIndexOf("/");
  if (slashIndex === -1) return null;

  const displayBase = normalizedQuery.slice(0, slashIndex + 1);
  const query = normalizedQuery.slice(slashIndex + 1);

  let baseDir: string;
  if (displayBase.startsWith("~/")) {
    baseDir = expandHomePath(displayBase);
  } else if (displayBase.startsWith("/")) {
    baseDir = displayBase;
  } else {
    baseDir = join(basePath, displayBase);
  }

  try {
    if (!statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }

  return { baseDir, query, displayBase };
}

function scopedPathForDisplay(displayBase: string, relativePath: string): string {
  const norm = toDisplayPath(relativePath);
  if (displayBase === "/") return `/${norm}`;
  return `${toDisplayPath(displayBase)}${norm}`;
}

// ---------------------------------------------------------------------------
// fzf-style Smith-Waterman DP scorer
// ---------------------------------------------------------------------------

const SCORE_MATCH = 16;
const SCORE_GAP = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 7;
const BONUS_START = 12;
const BONUS_CONSECUTIVE_BASE = 4;

function charBonus(prev: string, cur: string): number {
  if (prev === "") return BONUS_START;
  if ("/\\-_. ".includes(prev)) return BONUS_BOUNDARY;
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return BONUS_CAMEL;
  return 0;
}

/**
 * Score `query` against `text` using a rolling Smith-Waterman DP.
 * Higher = better.  Returns -Infinity when the query is not a subsequence.
 */
function dpScore(query: string, text: string): number {
  const m = query.length;
  const n = text.length;
  if (m === 0) return 0;
  if (m > n) return -Infinity;

  const lq = query.toLowerCase();
  const lt = text.toLowerCase();

  // Forward pass: verify query is a subsequence at all
  let qi = 0;
  for (let ti = 0; ti < n && qi < m; ti++) {
    if (lt[ti] === lq[qi]) qi++;
  }
  if (qi < m) return -Infinity;

  const INF = -1e9;
  const dp: number[] = Array.from({ length: n }, () => INF);
  const consec: number[] = Array.from({ length: n }, () => 0);

  // Seed with first query character
  for (let j = 0; j < n; j++) {
    if (lt[j] === lq[0]) {
      const prev = j > 0 ? (text[j - 1] ?? "") : "";
      dp[j] = SCORE_MATCH + charBonus(prev, text[j] ?? "");
      consec[j] = 1;
    }
  }

  // Rolling DP for remaining query characters
  for (let i = 1; i < m; i++) {
    const newDp: number[] = Array.from({ length: n }, () => INF);
    const newConsec: number[] = Array.from({ length: n }, () => 0);

    let best = INF;
    let bestJ = -1;

    for (let j = i; j < n; j++) {
      if ((dp[j - 1] ?? INF) > best) {
        best = dp[j - 1]!;
        bestJ = j - 1;
      }

      if (lt[j] !== lq[i]) continue;

      const prev = j > 0 ? (text[j - 1] ?? "") : "";
      const bonus = charBonus(prev, text[j] ?? "");

      let score = INF;
      let run = 1;

      // Consecutive match from j-1
      if (j > 0 && (dp[j - 1] ?? INF) > INF && lt[j - 1] === lq[i - 1]) {
        run = (consec[j - 1] ?? 0) + 1;
        score = dp[j - 1]! + SCORE_MATCH + bonus + BONUS_CONSECUTIVE_BASE * run;
      }

      // Gap from best earlier match position
      if (best > INF) {
        const gapLen = j - 1 - bestJ;
        const gapScore = best + SCORE_GAP * gapLen + SCORE_MATCH + bonus;
        if (gapScore > score) {
          score = gapScore;
          run = 1;
        }
      }

      if (score > (newDp[j] ?? INF)) {
        newDp[j] = score;
        newConsec[j] = run;
      }
    }

    for (let j = 0; j < n; j++) {
      dp[j] = newDp[j]!;
      consec[j] = newConsec[j]!;
    }
  }

  let best = INF;
  for (const s of dp) {
    if (s > best) best = s;
  }
  return best === INF ? -Infinity : best;
}

/**
 * When a query contains slashes (e.g. `./scr/fzf`) and the directory part
 * doesn't exist on disk, `resolveScopedFuzzyQuery` returns null and we fall
 * back to matching the whole query string against full paths.
 *
 * Treating the slashes as literal subsequence characters fails because the
 * characters after each `/` end up needing to match in the wrong order.
 * Instead, strip any leading `./`, split the query by `/`, then match each
 * segment independently (in order) against the corresponding path segments.
 *
 * e.g. `./scr/fzf` → segments `["scr", "fzf"]`
 *      `.scratch/fzf-file-search.ts` → `[".scratch", "fzf-file-search.ts"]`
 *      → `scr` scores against `.scratch`, `fzf` against `fzf-file-search.ts`
 */
function fzfScoreSegmented(query: string, path: string): number {
  // Strip leading "./" or "/" — they are navigation prefixes, not match targets
  const stripped = query.replace(/^\.?\//, "");
  const querySegs = stripped.split("/").filter(Boolean);
  const pathSegs = path.split("/");

  if (querySegs.length === 0) return 0;

  let totalScore = 0;
  let pathIdx = 0;

  for (const qSeg of querySegs) {
    let bestScore = -Infinity;
    let bestIdx = -1;

    for (let j = pathIdx; j < pathSegs.length; j++) {
      const s = dpScore(qSeg, pathSegs[j] ?? "");
      if (s > bestScore) {
        bestScore = s;
        bestIdx = j;
      }
    }

    if (bestScore === -Infinity) return -Infinity;
    totalScore += bestScore;
    pathIdx = bestIdx + 1;
  }

  return totalScore;
}

/**
 * Score `query` against a file `path`.
 * Scores the basename first (higher weight); uses full-path score as tiebreaker.
 * Path-only matches (no basename hit) are penalised by -1000.
 * Queries containing `/` use segmented scoring (see `fzfScoreSegmented`).
 */
export function fzfScore(query: string, path: string): number {
  if (!query) return 0;
  const clean = path.endsWith("/") ? path.slice(0, -1) : path;

  // Slashes in the query mean resolveScopedFuzzyQuery couldn't resolve a real
  // directory — use per-segment matching instead of flat subsequence.
  if (query.includes("/")) return fzfScoreSegmented(query, clean);

  const name = basename(clean);
  const baseScore = dpScore(query, name);
  if (baseScore === -Infinity) {
    const fullScore = dpScore(query, clean);
    return fullScore === -Infinity ? -Infinity : fullScore - 1000;
  }

  const fullScore = dpScore(query, clean);
  return baseScore * 10 + (fullScore === -Infinity ? 0 : fullScore);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const cwd = ctx.cwd;

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);

        const atPrefix = extractAtPrefix(before);
        // Not an @ token — delegate to the built-in provider
        if (!atPrefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);

        // "@@" prefix (rawPrefix starts with "@") opts into --no-ignore,
        // surfacing gitignored files while still blocking .git and node_modules.
        const includeIgnored = rawPrefix.startsWith("@");
        const queryPrefix = includeIgnored ? rawPrefix.slice(1) : rawPrefix;

        // Resolve scoped query: "@src/foo" → base=src/, query="foo"
        const scoped = resolveScopedFuzzyQuery(queryPrefix, cwd);
        const fdBase = scoped?.baseDir ?? cwd;
        const fdQuery = scoped?.query ?? queryPrefix;

        // Run fd unfiltered from the appropriate base — we score client-side
        // so we never pass a regex pattern, enabling true subsequence matching.
        // No --max-results cap: fd is fast and a hard cap would silently hide
        // files in large repos.
        const fdArgs = [
          "--base-directory",
          fdBase,
          "--type",
          "f",
          "--type",
          "d",
          "--follow",
          "--hidden",
          "--exclude",
          ".git",
        ];

        if (includeIgnored) {
          fdArgs.push("--no-ignore", "--exclude", "node_modules");
        }

        const result = await pi.exec("fd", fdArgs, {
          cwd: fdBase,
          signal: options.signal,
          timeout: 5000,
        });

        if (options.signal.aborted) return null;
        if (result.code !== 0 && !result.stdout) return null;

        const paths = result.stdout.trim().split("\n").filter(Boolean);

        // Score and rank
        let ranked: Array<{ path: string; isDirectory: boolean }>;
        if (!fdQuery) {
          // Empty query after scope resolution → stable sort by depth then alpha
          ranked = paths
            .map((p) => ({ path: p, isDirectory: p.endsWith("/") }))
            .sort((a, b) => {
              const da = a.path.split("/").length;
              const db = b.path.split("/").length;
              if (da !== db) return da - db;
              return a.path.localeCompare(b.path);
            })
            .slice(0, 20);
        } else {
          ranked = paths
            .map((p) => ({ path: p, isDirectory: p.endsWith("/"), score: fzfScore(fdQuery, p) }))
            .filter((x) => x.score > -Infinity)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
        }

        // Build completion items
        const items: AutocompleteItem[] = ranked.map(({ path: p, isDirectory }) => {
          const pathWithoutSlash = isDirectory ? p.slice(0, -1) : p;
          const displayPath = scoped
            ? scopedPathForDisplay(scoped.displayBase, pathWithoutSlash)
            : pathWithoutSlash;
          const completionPath = isDirectory ? `${displayPath}/` : displayPath;
          const value = buildCompletionValue(completionPath, {
            isDirectory,
            isAtPrefix: true,
            isQuotedPrefix,
          });

          return {
            value,
            label: basename(pathWithoutSlash) + (isDirectory ? "/" : ""),
            description: displayPath,
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
