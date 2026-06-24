import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";
import type { SnacksConfig } from "./config.js";

type FileState = { exists: false } | { exists: true; blob: string; bytes: number };

type Checkpoint = {
  id: string;
  createdAt: string;
  label: string;
  files: Record<string, FileState>;
  changedFiles: string[];
};

type Store = { version: 1; checkpoints: Checkpoint[] };

type Pending = { path: string; before: FileState };

const EMPTY_STORE: Store = { version: 1, checkpoints: [] };

function keyForCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

function paths(cwd: string, sessionId: string) {
  const root = join(getAgentDir(), "pi-bites", "rollback", keyForCwd(cwd), sessionId);
  return { root, gitDir: join(root, "objects.git"), meta: join(root, "checkpoints.json") };
}

function sessionId(ctx: { sessionManager?: { getHeader: () => { id: string } | null } }): string {
  return ctx.sessionManager?.getHeader()?.id ?? "no-session";
}

function cwdRelative(cwd: string, rawPath: string): string | null {
  const abs = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

async function git(gitDir: string, args: string[], stdin?: Buffer): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [`--git-dir=${gitDir}`, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `git exited ${code}`));
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function ensureGit(gitDir: string): Promise<void> {
  if (existsSync(gitDir)) return;
  await mkdir(dirname(gitDir), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init", "--bare", gitDir], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git init failed: ${code}`)),
    );
  });
}

async function loadStore(cwd: string, currentSessionId: string): Promise<Store> {
  try {
    return JSON.parse(await readFile(paths(cwd, currentSessionId).meta, "utf8")) as Store;
  } catch {
    return { ...EMPTY_STORE, checkpoints: [] };
  }
}

async function saveStore(cwd: string, currentSessionId: string, store: Store): Promise<void> {
  const p = paths(cwd, currentSessionId).meta;
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2) + "\n", "utf8");
}

async function snapshotPath(
  cwd: string,
  currentSessionId: string,
  relPath: string,
): Promise<FileState> {
  const full = join(cwd, relPath);
  if (!existsSync(full)) return { exists: false };
  const data = await readFile(full);
  const { gitDir } = paths(cwd, currentSessionId);
  await ensureGit(gitDir);
  const blob = await git(gitDir, ["hash-object", "-w", "--stdin"], data);
  return { exists: true, blob, bytes: data.length };
}

function copyFiles(files: Record<string, FileState>): Record<string, FileState> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { ...v }]));
}

function formatCheckpoint(cp: Checkpoint, index: number): string {
  const time = new Date(cp.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const fileWord = cp.changedFiles.length === 1 ? "file" : "files";
  return `${index + 1}. ${time} ${cp.label} — ${cp.changedFiles.length} ${fileWord}`;
}

async function restoreFile(
  cwd: string,
  currentSessionId: string,
  relPath: string,
  state: FileState,
): Promise<void> {
  const full = join(cwd, relPath);
  if (!state.exists) {
    await rm(full, { force: true });
    return;
  }
  const data = await git(paths(cwd, currentSessionId).gitDir, ["cat-file", "blob", state.blob]);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data, "utf8");
}

export default function registerRollback(
  pi: ExtensionAPI,
  configRef: { current: SnacksConfig },
): void {
  const pending = new Map<string, Pending>();

  pi.on("tool_call", async (event, ctx) => {
    if (configRef.current.rollback?.enabled === false) return;
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
    const relPath = cwdRelative(ctx.cwd, event.input.path);
    if (!relPath) return;
    try {
      const currentSessionId = sessionId(ctx);
      pending.set(event.toolCallId, {
        path: relPath,
        before: await snapshotPath(ctx.cwd, currentSessionId, relPath),
      });
    } catch (error) {
      console.warn("rollback pre-snapshot failed", error);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (configRef.current.rollback?.enabled === false) return;
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
    const rawPath = event.input.path;
    if (typeof rawPath !== "string") return;
    const relPath = cwdRelative(ctx.cwd, rawPath);
    if (!relPath) return;
    try {
      const currentSessionId = sessionId(ctx);
      const store = await loadStore(ctx.cwd, currentSessionId);
      const last = store.checkpoints.at(-1);
      const priorFiles = copyFiles(last?.files ?? {});
      const before =
        pending.get(event.toolCallId)?.before ??
        (await snapshotPath(ctx.cwd, currentSessionId, relPath));
      if (!last) {
        store.checkpoints.push({
          id: `${Date.now()}-initial`,
          createdAt: new Date().toISOString(),
          label: "before Pi changes",
          files: { [relPath]: before },
          changedFiles: [relPath],
        });
      } else if (!(relPath in priorFiles)) {
        // Backfill the path's pre-Pi state into older checkpoints so rolling
        // back before the first Pi mutation of this file restores/deletes it.
        for (const checkpoint of store.checkpoints) checkpoint.files[relPath] = before;
        priorFiles[relPath] = before;
      }
      priorFiles[relPath] = await snapshotPath(ctx.cwd, currentSessionId, relPath);
      store.checkpoints.push({
        id: `${Date.now()}-${store.checkpoints.length}`,
        createdAt: new Date().toISOString(),
        label: `after ${event.toolName} ${relPath}`,
        files: priorFiles,
        changedFiles: [relPath],
      });
      await saveStore(ctx.cwd, currentSessionId, store);
    } catch (error) {
      console.warn("rollback checkpoint failed", error);
    } finally {
      pending.delete(event.toolCallId);
    }
  });

  pi.registerCommand("rollback", {
    description: "Restore Pi-authored file changes to a previous checkpoint",
    handler: async (_args, ctx) => {
      if (configRef.current.rollback?.enabled === false) {
        ctx.ui.notify("Rollback tracking is disabled in pi-bites config.", "warning");
        return;
      }
      const currentSessionId = sessionId(ctx);
      const store = await loadStore(ctx.cwd, currentSessionId);
      if (store.checkpoints.length === 0) {
        ctx.ui.notify("No rollback checkpoints recorded yet.", "info");
        return;
      }
      const newestFirst = [...store.checkpoints].reverse();
      const choices = newestFirst.map((cp, i) => formatCheckpoint(cp, i));
      const choice = await ctx.ui.select("Rollback to checkpoint", [...choices, "Cancel"]);
      if (!choice || choice === "Cancel") return;
      const cp = newestFirst[choices.indexOf(choice)];
      if (!cp) return;
      const files = Object.keys(cp.files).sort();
      const preview = files
        .map((f) => `  ${cp.files[f]?.exists ? "restore" : "delete "} ${f}`)
        .join("\n");
      const confirm = await ctx.ui.select(
        `Rollback will affect ${files.length} file(s):\n${preview}`,
        ["Confirm rollback", "Cancel"],
      );
      if (confirm !== "Confirm rollback") return;
      for (const file of files) await restoreFile(ctx.cwd, currentSessionId, file, cp.files[file]!);
      store.checkpoints = store.checkpoints.slice(
        0,
        store.checkpoints.findIndex((c) => c.id === cp.id) + 1,
      );
      await saveStore(ctx.cwd, currentSessionId, store);
      ctx.ui.notify(`Rollback complete. Restored ${files.length} file(s).`, "info");
    },
  });
}
