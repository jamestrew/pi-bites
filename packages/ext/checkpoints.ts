import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";
import type { BitesConfig } from "./config.js";

type FileState = { exists: false } | { exists: true; blob: string; bytes: number };

type Checkpoint = {
  id: string;
  createdAt: string;
  label: string;
  files: Record<string, FileState>;
  changedFiles: string[];
  userEntryId?: string;
  userPrompt?: string;
};

type Store = { version: 1; checkpoints: Checkpoint[] };

type Pending = { path: string; before: FileState; userEntryId?: string; userPrompt?: string };
type RewindPoint = { before: Checkpoint; after: Checkpoint; first: Checkpoint; stat: string };
type RollbackCommandContext = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] extends (
  args: string,
  ctx: infer C,
) => unknown
  ? C
  : never;

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

const EMPTY_STORE: Store = { version: 1, checkpoints: [] };

function keyForCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

function paths(cwd: string, sessionId: string) {
  const root = join(getAgentDir(), "pi-bites", "checkpoints", keyForCwd(cwd), sessionId);
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

function textFromMessage(message: unknown): string | null {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function latestUser(ctx: { sessionManager?: { getBranch?: () => unknown[] } }) {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { id?: string; type?: string; message?: { role?: string } };
    if (entry.type === "message" && entry.message?.role === "user" && entry.id) {
      return {
        userEntryId: entry.id,
        userPrompt: textFromMessage(entry.message) ?? "user message",
      };
    }
  }
  return {};
}

function shortPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 120) || "user message";
}

function age(date: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

async function blobText(gitDir: string, state: FileState): Promise<string> {
  if (!state.exists) return "";
  return await git(gitDir, ["cat-file", "blob", state.blob]);
}

async function lineDelta(gitDir: string, from: FileState | undefined, to: FileState | undefined) {
  const a = await blobText(gitDir, from ?? { exists: false });
  const b = await blobText(gitDir, to ?? { exists: false });
  const count = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);
  return count(b) - count(a);
}

async function statLine(
  gitDir: string,
  from: Record<string, FileState>,
  to: Record<string, FileState>,
): Promise<string> {
  const files = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  const parts = [];
  for (const file of files) {
    const delta = await lineDelta(gitDir, from[file], to[file]);
    if (delta) parts.push(`${file} ${delta > 0 ? "+" : ""}${delta}`);
  }
  return parts.join(", ") || "no code changes";
}

function truncatePlain(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return (
    Array.from(text)
      .slice(0, Math.max(0, width - 1))
      .join("") + "…"
  );
}

function styledStat(stat: string, theme: Theme): string {
  if (stat === "no code changes") return theme.fg("dim", stat);
  return stat
    .split(", ")
    .map((part) => {
      const match = /^(.*) ([+-]\d+)$/.exec(part);
      if (!match) return theme.fg("dim", part);
      const [, file, delta] = match;
      return `${theme.fg("dim", file)} ${theme.fg(delta.startsWith("+") ? "success" : "error", delta)}`;
    })
    .join(theme.fg("dim", ", "));
}

function border(theme: Theme, width: number): string {
  return theme.fg("accent", "─".repeat(Math.max(1, width)));
}

async function selectRewindPoint(
  ctx: RollbackCommandContext,
  points: RewindPoint[],
): Promise<RewindPoint | null> {
  return await ctx.ui.custom<RewindPoint | null>((tui, theme, _kb, done) => {
    let selected = 0;
    const rows = [...points, null];
    const renderRow = (point: RewindPoint | null, active: boolean, width: number): string[] => {
      const prefix = active ? " ❯ " : "   ";
      const label = point ? shortPrompt(point.first.userPrompt ?? point.first.label) : "(current)";
      const labelText = truncatePlain(label, Math.max(1, width - visibleWidth(prefix)));
      const firstLine = `${prefix}${active ? theme.fg("accent", theme.bold(labelText)) : labelText}`;
      if (!point) return [firstLine];
      return [firstLine, `   ${styledStat(point.stat, theme)}`];
    };
    return {
      render(width) {
        return [
          border(theme, width),
          " Rewind",
          "",
          " Restore the code and/or conversation to the point before…",
          "",
          ...rows.flatMap((row, i) => renderRow(row, i === selected, width)),
          "",
          theme.fg("dim", " ↑↓ navigate  enter/ctrl+y select  escape/ctrl+c cancel"),
          border(theme, width),
        ];
      },
      handleInput(data) {
        const kb = getKeybindings();
        if (kb.matches(data, KEYBIND_UP)) selected = (selected - 1 + rows.length) % rows.length;
        else if (kb.matches(data, KEYBIND_DOWN)) selected = (selected + 1) % rows.length;
        else if (kb.matches(data, KEYBIND_CONFIRM)) return done(rows[selected] ?? null);
        else if (kb.matches(data, KEYBIND_CANCEL)) return done(null);
        tui.requestRender();
      },
      invalidate() {},
    } satisfies Component;
  });
}

async function selectRestoreAction(
  ctx: RollbackCommandContext,
  point: RewindPoint,
  delta: string,
): Promise<"fork" | "code" | null> {
  const actions = ["1. Restore code and conversation", "2. Restore code", "Cancel"] as const;
  return await ctx.ui.custom<"fork" | "code" | null>((tui, theme, _kb, done) => {
    let selected = 0;
    const finish = () => done(selected === 0 ? "fork" : selected === 1 ? "code" : null);
    return {
      render(width) {
        const prompt = truncatePlain(
          shortPrompt(point.first.userPrompt ?? point.first.label),
          Math.max(1, width - 3),
        );
        return [
          border(theme, width),
          " Confirm you want to restore to the point before you sent this message:",
          "",
          ` │ ${theme.bold(prompt)}`,
          " │ " + theme.fg("dim", `(${age(point.first.createdAt)})`),
          "",
          ` The following code will be restored `,
          `   ${styledStat(delta, theme)}.`,
          "",
          ...actions.map((action, i) => {
            const line = `${i === selected ? " ❯ " : "   "}${action}`;
            return i === selected ? theme.fg("accent", theme.bold(line)) : theme.fg("dim", line);
          }),
          "",
          theme.fg("dim", " ↑↓ navigate  enter/ctrl+y select  escape/ctrl+c cancel"),
          border(theme, width),
        ];
      },
      handleInput(data) {
        const kb = getKeybindings();
        if (kb.matches(data, KEYBIND_UP))
          selected = (selected - 1 + actions.length) % actions.length;
        else if (kb.matches(data, KEYBIND_DOWN)) selected = (selected + 1) % actions.length;
        else if (kb.matches(data, KEYBIND_CONFIRM)) return finish();
        else if (kb.matches(data, KEYBIND_CANCEL)) return done(null);
        tui.requestRender();
      },
      invalidate() {},
    } satisfies Component;
  });
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

async function buildRewindPoints(store: Store, gitDir: string): Promise<RewindPoint[]> {
  const points: RewindPoint[] = [];
  for (let i = 1; i < store.checkpoints.length; i++) {
    const first = store.checkpoints[i]!;
    const userEntryId = first.userEntryId;
    if (!userEntryId) continue;
    let end = i;
    while (store.checkpoints[end + 1]?.userEntryId === userEntryId) end++;
    const stat = await statLine(
      gitDir,
      store.checkpoints[i - 1]!.files,
      store.checkpoints[end]!.files,
    );
    points.push({
      before: store.checkpoints[i - 1]!,
      after: store.checkpoints[end]!,
      first,
      stat,
    });
    i = end;
  }
  return points;
}

async function executeRestore(
  ctx: RollbackCommandContext,
  cwd: string,
  currentSessionId: string,
  point: RewindPoint,
  store: Store,
): Promise<void> {
  const files = Object.keys(point.before.files).sort();
  for (const file of files) {
    await restoreFile(cwd, currentSessionId, file, point.before.files[file]!);
  }
  store.checkpoints = store.checkpoints.slice(
    0,
    store.checkpoints.findIndex((c) => c.id === point.before.id) + 1,
  );
  await saveStore(cwd, currentSessionId, store);
}

type PrepareCheckpointArgs = {
  cwd: string;
  sessionId: string;
  relPath: string;
  toolName: string;
  store: Store;
  pendingChange: Pending | undefined;
  ctx: { sessionManager?: { getBranch?: () => unknown[] } };
};

async function prepareCheckpoint(args: PrepareCheckpointArgs): Promise<Checkpoint | null> {
  const { cwd, sessionId, relPath, toolName, store, pendingChange, ctx } = args;
  const last = store.checkpoints.at(-1);
  const priorFiles = copyFiles(last?.files ?? {});
  const user = pendingChange?.userEntryId ? pendingChange : latestUser(ctx);
  const before = pendingChange?.before ?? (await snapshotPath(cwd, sessionId, relPath));

  // Create initial checkpoint if needed
  if (!last) {
    store.checkpoints.push({
      id: `${Date.now()}-initial`,
      createdAt: new Date().toISOString(),
      label: "before Pi changes",
      files: { [relPath]: before },
      changedFiles: [relPath],
      userEntryId: user.userEntryId,
      userPrompt: user.userPrompt,
    });
  } else if (!(relPath in priorFiles)) {
    // Backfill the path's pre-Pi state into older checkpoints
    for (const checkpoint of store.checkpoints) checkpoint.files[relPath] = before;
    priorFiles[relPath] = before;
  }

  // Update prior files with current state
  priorFiles[relPath] = await snapshotPath(cwd, sessionId, relPath);

  return {
    id: `${Date.now()}-${store.checkpoints.length}`,
    createdAt: new Date().toISOString(),
    label: `after ${toolName} ${relPath}`,
    files: priorFiles,
    changedFiles: [relPath],
    userEntryId: user.userEntryId,
    userPrompt: user.userPrompt,
  };
}

export default function registerCheckpoints(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  const pending = new Map<string, Pending>();

  pi.on("tool_call", async (event, ctx) => {
    if (configRef.current.checkpoints?.enabled === false) return;
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
    const relPath = cwdRelative(ctx.cwd, event.input.path);
    if (!relPath) return;
    try {
      const currentSessionId = sessionId(ctx);
      const user = latestUser(ctx);
      pending.set(event.toolCallId, {
        path: relPath,
        before: await snapshotPath(ctx.cwd, currentSessionId, relPath),
        userEntryId: user.userEntryId,
        userPrompt: user.userPrompt,
      });
    } catch (error) {
      console.warn("checkpoints pre-snapshot failed", error);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (configRef.current.checkpoints?.enabled === false) return;
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
    const rawPath = event.input.path;
    if (typeof rawPath !== "string") return;
    const relPath = cwdRelative(ctx.cwd, rawPath);
    if (!relPath) return;
    try {
      const currentSessionId = sessionId(ctx);
      const store = await loadStore(ctx.cwd, currentSessionId);
      const pendingChange = pending.get(event.toolCallId);
      const checkpoint = await prepareCheckpoint({
        cwd: ctx.cwd,
        sessionId: currentSessionId,
        relPath,
        toolName: event.toolName,
        store,
        pendingChange,
        ctx,
      });
      if (checkpoint) store.checkpoints.push(checkpoint);
      await saveStore(ctx.cwd, currentSessionId, store);
    } catch (error) {
      console.warn("checkpoints checkpoint failed", error);
    } finally {
      pending.delete(event.toolCallId);
    }
  });

  pi.registerCommand("rewind", {
    description: "Restore code to a previous checkpoint before a message",
    handler: async (_args, ctx) => {
      if (configRef.current.checkpoints?.enabled === false) {
        ctx.ui.notify("Checkpoint tracking is disabled in pi-bites config.", "warning");
        return;
      }
      const currentSessionId = sessionId(ctx);
      const store = await loadStore(ctx.cwd, currentSessionId);
      if (store.checkpoints.length === 0) {
        ctx.ui.notify("No checkpoints recorded yet.", "info");
        return;
      }
      const points = await buildRewindPoints(store, paths(ctx.cwd, currentSessionId).gitDir);
      if (points.length === 0) {
        ctx.ui.notify("No message-level checkpoints recorded yet.", "info");
        return;
      }
      const point = await selectRewindPoint(ctx, points);
      if (!point) return;
      const files = Object.keys(point.before.files).sort();
      const delta = await statLine(
        paths(ctx.cwd, currentSessionId).gitDir,
        point.after.files,
        point.before.files,
      );
      const action = await selectRestoreAction(ctx, point, delta);
      if (action === "fork") {
        await ctx.fork(point.first.userEntryId!, {
          position: "before",
          withSession: async (forkCtx) => {
            await executeRestore(forkCtx, forkCtx.cwd, currentSessionId, point, store);
            forkCtx.ui.notify(`Rewind complete. Restored ${files.length} file(s).`, "info");
          },
        });
      } else if (action === "code") {
        await executeRestore(ctx, ctx.cwd, currentSessionId, point, store);
        ctx.ui.notify(`Rollback complete. Restored ${files.length} file(s).`, "info");
      }
    },
  });
}
