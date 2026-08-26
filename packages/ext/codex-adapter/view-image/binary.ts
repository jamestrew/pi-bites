import { fileURLToPath } from "node:url";

export function getBundledViewImagePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "linux" || arch !== "x64") return undefined;
  return fileURLToPath(new URL("./bin/linux-x64/view_image", import.meta.url));
}
