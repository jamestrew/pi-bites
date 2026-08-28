import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getBundledWebRunPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) return undefined;
  const path = fileURLToPath(new URL(`./bin/linux-${arch}/web_run`, import.meta.url));
  return existsSync(path) ? path : undefined;
}
