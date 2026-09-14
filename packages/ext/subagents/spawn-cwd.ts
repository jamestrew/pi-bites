import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Validate an untrusted SpawnOptions.cwd before it reaches path/fs internals. */
export function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string") throw new Error(`SpawnOptions.cwd must be an absolute path`);
  if (!isAbsolute(cwd)) throw new Error(`SpawnOptions.cwd must be an absolute path: "${cwd}"`);

  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
}
