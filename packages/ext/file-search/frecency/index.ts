import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import * as Value from "typebox/value";

const HALF_LIFE_SECONDS = 30 * 24 * 3600;
const LAMBDA = Math.log(2) / HALF_LIFE_SECONDS;
const DEFAULT_VISIT_VALUE = 1;
const MAX_STORE_SIZE = 10_000;

type FrecencyStore = Record<string, Record<string, number>>;

function defaultStoreFile(): string {
  const base =
    process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "state");
  return join(base, "pi-bites", "file-frecency.json");
}

export const FrecencyStoreSchema = Type.Record(
  Type.String(),
  Type.Union([Type.Number(), Type.Record(Type.String(), Type.Number())]),
);

export function parseFrecencyStore(value: unknown): FrecencyStore | undefined {
  if (!Value.Check(FrecencyStoreSchema, value)) return undefined;
  const store: FrecencyStore = {};

  for (const [key, entry] of Object.entries(value)) {
    const value = entry;
    if (typeof value === "number" && Number.isFinite(value)) {
      // Back-compat for the original flat `${cwd}\0${path}` key format.
      const separator = key.indexOf("\0");
      if (separator === -1) continue;
      const cwd = key.slice(0, separator);
      const path = key.slice(separator + 1);
      store[cwd] ??= {};
      store[cwd][path] = value;
      continue;
    }

    const entries = Object.entries(value).filter((entry) => Number.isFinite(entry[1]));
    if (entries.length > 0) store[key] = Object.fromEntries(entries);
  }

  return store;
}

export class FileFrecency {
  private readonly file: string;
  private cwd: string | undefined;
  private cache = new Map<string, number>();
  private pruned = new Set<string>();
  private loaded = false;

  constructor(file = defaultStoreFile()) {
    this.file = file;
  }

  async load(cwd: string): Promise<void> {
    if (this.loaded && this.cwd === cwd) return;

    this.cwd = cwd;
    this.loaded = true;

    try {
      const raw = await readFile(this.file, "utf8");
      const store = parseFrecencyStore(JSON.parse(raw)) ?? {};
      this.cache = new Map(Object.entries(store[cwd] ?? {}));
      this.pruned.clear();
    } catch {
      this.cache = new Map();
      this.pruned.clear();
    }
  }

  score(path: string, now = Date.now() / 1000): number {
    const deadline = this.cache.get(path);
    if (deadline === undefined) return 0;
    return Math.exp(LAMBDA * (deadline - now));
  }

  visit(path: string, value = DEFAULT_VISIT_VALUE): void {
    const now = Date.now() / 1000;
    const nextScore = this.score(path, now) + value;
    const deadline = now + Math.log(nextScore) / LAMBDA;
    this.cache.set(path, deadline);
    this.pruned.delete(path);
  }

  pruneMissing(paths: Iterable<string>): number {
    const existing = new Set(paths);
    let removed = 0;

    for (const path of this.cache.keys()) {
      if (existing.has(path)) continue;
      this.cache.delete(path);
      this.pruned.add(path);
      removed += 1;
    }

    return removed;
  }

  async save(): Promise<void> {
    if (!this.cwd) return;

    let store: FrecencyStore = {};
    try {
      const raw = await readFile(this.file, "utf8");
      store = parseFrecencyStore(JSON.parse(raw)) ?? {};
    } catch {
      store = {};
    }

    const merged = new Map(Object.entries(store[this.cwd] ?? {}));

    for (const path of this.pruned) {
      merged.delete(path);
    }

    for (const [path, deadline] of this.cache) {
      merged.set(path, Math.max(merged.get(path) ?? Number.NEGATIVE_INFINITY, deadline));
    }

    store[this.cwd] = Object.fromEntries(
      [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_STORE_SIZE),
    );
    this.cache = new Map(Object.entries(store[this.cwd]));
    this.pruned.clear();

    await mkdir(dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(store), "utf8");
    await rename(tmpFile, this.file);
  }
}
