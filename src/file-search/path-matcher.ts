import { scorePath } from "./path-scorer.js";

export interface PathSearchItem {
  path: string;
  lowerPath: string;
}

export interface PathSearchResult {
  path: string;
  score: number;
}

const DEFAULT_LIMIT = 20;
const EMPTY_QUERY_SCORE = 1000;

function normalizeItem(item: PathSearchItem | string): PathSearchItem {
  if (typeof item === "string") return { path: item, lowerPath: item.toLowerCase() };
  return item;
}

function compareRankedResults(
  a: PathSearchResult & { index: number },
  b: PathSearchResult & { index: number },
): number {
  return b.score - a.score || a.index - b.index;
}

function insertTopResult(
  results: Array<PathSearchResult & { index: number }>,
  result: PathSearchResult & { index: number },
  limit: number,
) {
  let insertIndex = results.length;

  while (insertIndex > 0 && compareRankedResults(result, results[insertIndex - 1]) < 0) {
    insertIndex -= 1;
  }

  if (insertIndex >= limit) return;

  results.splice(insertIndex, 0, result);
  if (results.length > limit) results.pop();
}

export function searchPaths(
  query: string,
  items: PathSearchItem[] | string[],
  options: { limit?: number } = {},
): PathSearchResult[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  if (query === "") {
    const results: PathSearchResult[] = [];
    const resultCount = Math.min(limit, items.length);

    for (let index = 0; index < resultCount; index++) {
      const item = normalizeItem(items[index]);
      results.push({ path: item.path, score: EMPTY_QUERY_SCORE });
    }

    return results;
  }

  const results: Array<PathSearchResult & { index: number }> = [];

  for (let index = 0; index < items.length; index++) {
    const item = normalizeItem(items[index]);
    const score = scorePath(query, item.path, item.lowerPath)?.score ?? 0;

    if (score > 0) {
      insertTopResult(results, { path: item.path, score, index }, limit);
    }
  }

  return results.map(({ path, score }) => ({ path, score }));
}
