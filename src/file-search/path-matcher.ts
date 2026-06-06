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

export function searchPaths(
  query: string,
  items: PathSearchItem[] | string[],
  options: { limit?: number } = {},
): PathSearchResult[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const normalizedItems = items.map(normalizeItem);
  if (query === "") {
    return normalizedItems
      .slice(0, limit)
      .map((item) => ({ path: item.path, score: EMPTY_QUERY_SCORE }));
  }

  return normalizedItems
    .map((item, index) => ({
      path: item.path,
      score: scorePath(query, item.path)?.score ?? 0,
      index,
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ path, score }) => ({ path, score }));
}
