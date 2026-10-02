/** FFF ranks workspace mentions; Pi handles path browsing and unavailable results. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { FileFinder } from "@ff-labs/fff-node";

const MENTION_MAX_RESULTS = 20;
// NFS may not emit watcher events. Refresh on demand, at most once every 30 seconds.
const REFRESH_INTERVAL_MS = 30_000;

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|\s)[([{<`]*(@(?:"[^"]*"?|[^\s]*))$/u);
  return match?.[1] ?? null;
}

function queryFromPrefix(prefix: string): string {
  return prefix.startsWith('@"') ? prefix.slice(2).replace(/"$/, "") : prefix.slice(1);
}

// Pi splits unquoted mentions on whitespace and CJK punctuation.
const MENTION_SEPARATOR =
  /\s|(?=\p{Punctuation})[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]|[，．：；！？（）［］｛｝“”‘’…—]/u;

function buildAtCompletionValue(path: string, prefix: string): string {
  return prefix.startsWith('@"') || MENTION_SEPARATOR.test(path) ? `@"${path}"` : `@${path}`;
}

function existingDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

function statePathFor(cwd: string, name: string): string {
  const stateDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || tmpdir();
  const user =
    process.getuid?.() ?? createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
  const dir = join(stateDir, `pi-bites-fff-${user}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (
    !info.isDirectory() ||
    (process.geteuid && info.uid !== process.geteuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`FFF state directory is not private: ${dir}`);
  }
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(dir, `${digest}-${name}`);
}

export default function registerFzfFileSearch(pi: ExtensionAPI) {
  let dispose = () => {};
  let rescan = async () => {};

  pi.registerFlag("fff-frecency-db", {
    description: "FFF frecency database directory (existing Neovim database, otherwise local tmp)",
    type: "string",
  });
  pi.registerFlag("fff-history-db", {
    description:
      "FFF query history database directory (existing Neovim database, otherwise local tmp)",
    type: "string",
  });
  pi.registerCommand("fff-rescan", {
    description: "Refresh the FFF file completion index",
    handler: async () => rescan(),
  });
  pi.on("session_shutdown", () => dispose());

  pi.on("session_start", (_event, ctx) => {
    dispose();
    const cwd = ctx.cwd;
    const ui = ctx.ui;
    const notify = ui.notify.bind(ui);
    let active = true;
    const isActive = () => active;
    let finder: FileFinder | null = null;
    let pending: Promise<FileFinder> | null = null;
    let unavailable = false;
    let indexReady = false;
    let lastScan = Date.now();
    let fffFiles = new Set<AutocompleteItem>();
    const warned = new Set<string>();

    function warn(kind: string, message: string) {
      if (!isActive() || warned.has(kind)) return;
      warned.add(kind);
      notify(message, "warning");
    }

    function resetFinder() {
      if (finder && !finder.isDestroyed) {
        try {
          finder.destroy();
        } catch (error) {
          console.warn("FFF destroy failed", error);
        }
      }
      finder = null;
      indexReady = false;
      fffFiles.clear();
    }

    dispose = () => {
      active = false;
      resetFinder();
    };

    function ensureFinder(): Promise<FileFinder> {
      if (!isActive() || unavailable) return Promise.reject(new Error("FFF is unavailable"));
      if (pending) return pending;
      if (finder && !finder.isDestroyed) return Promise.resolve(finder);

      pending = Promise.resolve()
        .then(async () => {
          if (!isActive()) throw new Error("FFF session closed");
          const options = {
            basePath: cwd,
            aiMode: false,
            disableWatch: true,
            disableMmapCache: true,
            disableContentIndexing: true,
          };
          let result: ReturnType<typeof FileFinder.create>;
          try {
            const frecencyFlag = pi.getFlag("fff-frecency-db");
            const historyFlag = pi.getFlag("fff-history-db");
            const frecencyDbPath =
              (typeof frecencyFlag === "string" ? frecencyFlag : undefined) ??
              process.env.FFF_FRECENCY_DB ??
              existingDirectory(
                join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "nvim", "fff_nvim"),
              ) ??
              statePathFor(cwd, "frecency");
            const historyDbPath =
              (typeof historyFlag === "string" ? historyFlag : undefined) ??
              process.env.FFF_HISTORY_DB ??
              existingDirectory(
                join(
                  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
                  "nvim",
                  "fff_queries",
                ),
              ) ??
              statePathFor(cwd, "history");
            result = FileFinder.create({ ...options, frecencyDbPath, historyDbPath });
            if (!result.ok) throw new Error(result.error);
          } catch (error) {
            result = FileFinder.create(options);
            if (!result.ok) throw new Error(`FFF init failed: ${String(error)}; ${result.error}`);
            warn(
              "database",
              `FFF databases could not be opened: ${String(error)}. Using FFF without ranking history.`,
            );
          }
          const created = result.value;
          finder = created;
          const scan = await created.waitForScan(15_000);
          if (!isActive()) throw new Error("FFF session closed");
          if (!scan.ok) throw new Error(`FFF scan failed: ${scan.error}`);
          indexReady = scan.value;
          lastScan = Date.now();
          if (!indexReady)
            warn(
              "scan",
              "FFF is still indexing; using Pi completion until the initial scan finishes.",
            );
          return created;
        })
        .catch((error) => {
          unavailable = true;
          resetFinder();
          throw error;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    }

    function refresh(f: FileFinder) {
      if (f.isScanning()) return;
      const result = f.scanFiles();
      if (!result.ok) throw new Error(`FFF rescan failed: ${result.error}`);
      lastScan = Date.now();
    }

    rescan = async () => {
      try {
        unavailable = false;
        const f = await ensureFinder();
        if (!isActive()) return;
        refresh(f);
        notify("FFF file index refresh requested", "info");
      } catch (error) {
        warn("rescan", String(error));
      }
    };

    ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const isAborted = () => options.signal.aborted;
        if (!isActive() || isAborted()) return null;
        const prefix = extractAtPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
        if (prefix === null) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const query = queryFromPrefix(prefix);
        // Native mixedSearch treats trailing '/' as directories-only, not browsing.
        if (
          query.startsWith("~/") ||
          query.startsWith("/") ||
          query.startsWith("./") ||
          query.startsWith("../") ||
          query.endsWith("/")
        ) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        try {
          const f = await ensureFinder();
          if (!isActive() || isAborted()) return null;
          if (!indexReady) {
            indexReady = !f.isScanning();
            if (!indexReady) return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }
          if (Date.now() - lastScan >= REFRESH_INTERVAL_MS) refresh(f);
          const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
          if (!result.ok) throw new Error(`FFF search failed: ${result.error}`);
          fffFiles = new Set();
          const items: AutocompleteItem[] = result.value.items
            .slice(0, MENTION_MAX_RESULTS)
            .map((mixed) => {
              const item = {
                value: buildAtCompletionValue(mixed.item.relativePath, prefix),
                label: mixed.type === "directory" ? mixed.item.dirName : mixed.item.fileName,
                description: mixed.item.relativePath,
              };
              if (mixed.type === "file") fffFiles.add(item);
              return item;
            });
          return items.length > 0
            ? { prefix, items }
            : current.getSuggestions(lines, cursorLine, cursorCol, options);
        } catch (error) {
          if (!isActive() || isAborted()) return null;
          warn("search", `FFF completion unavailable: ${String(error)}. Using Pi completion.`);
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const completion = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        if (isActive() && finder && !finder.isDestroyed && fffFiles.has(item) && item.description) {
          try {
            const result = finder.trackQuery(
              queryFromPrefix(prefix),
              resolve(cwd, item.description),
            );
            if (!result.ok)
              warn("history", `FFF could not record completion history: ${result.error}`);
          } catch (error) {
            warn("history", `FFF could not record completion history: ${String(error)}`);
          }
        }
        return completion;
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
    void ensureFinder().catch((error) =>
      warn("search", `FFF completion unavailable: ${String(error)}. Using Pi completion.`),
    );
  });
}
