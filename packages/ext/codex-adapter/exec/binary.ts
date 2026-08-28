import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getBundledExecBridgePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) return undefined;
  const binary = join(
    dirname(fileURLToPath(import.meta.url)),
    "bin",
    `linux-${arch}`,
    "exec_bridge",
  );
  return existsSync(binary) ? binary : undefined;
}
