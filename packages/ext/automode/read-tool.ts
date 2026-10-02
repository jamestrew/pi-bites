import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, sep, isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { createReadTool } from "@earendil-works/pi-coding-agent";

const lineRange = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const parameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Local text file path, relative to execution cwd or absolute",
    }),
    offset: Type.Optional(lineRange),
    limit: Type.Optional(lineRange),
  },
  { additionalProperties: false },
);

// Bound physical I/O as well as model output. Larger scripts need explicit user inspection.
const MAX_FILE_BYTES = 256 * 1024;
const sensitive =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const privateDirectories = new Set([".ssh", ".aws", ".gnupg", ".pi", ".codex"]);

/** Local text-only capability, independent of extension replacements. Not an OS sandbox. */
export function createReviewerRead(cwd: string, workspace: string, signal: AbortSignal) {
  const inside = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
  };
  const lexicalRoot = resolve(workspace);
  let canonicalRoot: Promise<string> | undefined;
  const admit = async (path: string) => {
    signal.throwIfAborted();
    const root = await (canonicalRoot ??= realpath(lexicalRoot));
    if (!inside(root, path) && !inside(lexicalRoot, path))
      throw new Error("Reviewer read is outside the owning session workspace");
    const resolved = await realpath(path);
    if (!inside(root, resolved))
      throw new Error("Reviewer read escapes the owning session workspace");
    for (const candidate of [path, resolved]) {
      const segments = candidate.split(sep);
      if (
        segments.some((part) => sensitive.test(part) || privateDirectories.has(part.toLowerCase()))
      ) {
        throw new Error("Reviewer read of credential/private configuration is unavailable");
      }
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Reviewer reads require regular text files");
    if (info.size > MAX_FILE_BYTES)
      throw new Error("Reviewer file exceeds the 256 KiB input limit");
    signal.throwIfAborted();
    return { resolved, info };
  };
  const tool = createReadTool(cwd, {
    operations: {
      access: async (path) => {
        await admit(path);
      },
      readFile: async (path) => {
        const { resolved, info } = await admit(path);
        const file = await open(
          resolved,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
            throw new Error("Reviewer file changed before read");
          }
          // Recheck containment after open. Hostile concurrent filesystem replacement
          // still needs OS sandboxing; application path checks are not that guarantee.
          await admit(resolved);
          const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
          let size = 0;
          while (size < bytes.length) {
            signal.throwIfAborted();
            const read = await file.read(bytes, size, bytes.length - size, null);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          if (size > MAX_FILE_BYTES)
            throw new Error("Reviewer file exceeds the 256 KiB input limit");
          const data = bytes.subarray(0, size);
          new TextDecoder("utf-8", { fatal: true }).decode(data);
          if (data.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
            throw new Error("Reviewer reads require text, not binary/image content");
          }
          signal.throwIfAborted();
          return data;
        } finally {
          await file.close();
        }
      },
    },
  });
  return {
    ...tool,
    parameters,
    validateArguments(call: ToolCall): Static<typeof parameters> {
      const args: unknown = structuredClone(call.arguments);
      // Pi's argument validator coerces booleans/strings and truncates Integer
      // fractions. This capability accepts exactly its advertised schema instead.
      if (!Value.Check(parameters, args)) throw new Error("Invalid reviewer read arguments");
      return args;
    },
    description:
      "Read a regular UTF-8 text file inside the owning session workspace. No credential/private configuration or binary/images. Input is limited to 256 KiB; output pages to 8 KiB. Use positive integer offset/limit for targeted line ranges. Missing/truncated ranges are not evidence of harmless behavior.",
  };
}
