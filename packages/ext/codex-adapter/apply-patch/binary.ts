import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getBundledApplyPatchBinaryPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "linux" || arch !== "x64") return undefined;
  const path = fileURLToPath(new URL("./bin/linux-x64/apply_patch", import.meta.url));
  return existsSync(path) ? path : undefined;
}
