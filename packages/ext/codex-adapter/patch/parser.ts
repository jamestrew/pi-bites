import { normalizePatchPath } from "./paths.js";
import { DiffError, type ParsedPatchAction, type ParserState, type PatchAction } from "./types.js";

function parserIsDone({
  state,
  prefixes,
}: {
  state: ParserState;
  prefixes?: string[] | undefined;
}): boolean {
  const line = state.lines[state.index];
  if (line === undefined) return true;
  return prefixes?.some((prefix) => line.startsWith(prefix)) ?? false;
}

function parserReadStr({
  state,
  prefix,
  returnEverything,
}: {
  state: ParserState;
  prefix?: string | undefined;
  returnEverything?: boolean | undefined;
}): string {
  const line = state.lines[state.index];
  if (line === undefined) {
    throw new DiffError(`Index: ${state.index} >= ${state.lines.length}`);
  }

  const expectedPrefix = prefix ?? "";
  if (!line.startsWith(expectedPrefix)) return "";
  const text = returnEverything ? line : line.slice(expectedPrefix.length);
  state.index += 1;
  return text;
}

function parseAddFile({ state }: { state: ParserState }): PatchAction {
  const lines: string[] = [];
  while (
    !parserIsDone({
      state,
      prefixes: ["*** End Patch", "*** Update File:", "*** Delete File:", "*** Add File:"],
    })
  ) {
    const value = parserReadStr({ state, prefix: "" });
    if (!value.startsWith("+")) {
      throw new DiffError(`Invalid Add File Line: ${value}`);
    }
    lines.push(value.slice(1));
  }

  return {
    type: "add",
    newFile: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    chunks: [],
  };
}

const VALID_HUNK_HEADERS = [
  "'*** Add File: {path}'",
  "'*** Delete File: {path}'",
  "'*** Update File: {path}'",
].join(", ");

export function parsePatchActions({ text }: { text: string }): ParsedPatchAction[] {
  const lines = text.trim().split("\n");
  if (
    lines.length < 2 ||
    !lines[0]?.startsWith("*** Begin Patch") ||
    lines.at(-1) !== "*** End Patch"
  ) {
    throw new DiffError("Invalid patch text");
  }

  const actions: ParsedPatchAction[] = [];
  const seenPaths = new Set<string>();
  let index = 1;

  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === undefined) break;
    const lineNumber = index + 1;

    if (line.startsWith("*** Update File: ")) {
      const updatePath = normalizePatchPath({ path: line.slice("*** Update File: ".length) });
      if (seenPaths.has(updatePath)) {
        throw new DiffError(`Update File Error: Duplicate Path: ${updatePath}`);
      }
      seenPaths.add(updatePath);
      index += 1;
      let movePath: string | undefined;
      const possibleMove = lines[index];
      if (index < lines.length - 1 && possibleMove?.startsWith("*** Move to: ")) {
        movePath = normalizePatchPath({ path: possibleMove.slice("*** Move to: ".length) });
        index += 1;
      }
      const bodyStart = index;
      while (index < lines.length - 1) {
        const bodyLine = lines[index];
        if (
          bodyLine === undefined ||
          bodyLine.startsWith("*** Update File: ") ||
          bodyLine.startsWith("*** Delete File: ") ||
          bodyLine.startsWith("*** Add File: ")
        ) {
          break;
        }
        index += 1;
      }
      const bodyLines = lines.slice(bodyStart, index);
      if (bodyLines.length === 0) {
        throw new DiffError(
          `Invalid patch hunk on line ${lineNumber}: Update file hunk for path '${updatePath}' is empty`,
        );
      }
      actions.push({
        type: "update",
        path: updatePath,
        movePath,
        lines: bodyLines,
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const deletePath = normalizePatchPath({ path: line.slice("*** Delete File: ".length) });
      if (seenPaths.has(deletePath)) {
        throw new DiffError(`Delete File Error: Duplicate Path: ${deletePath}`);
      }
      seenPaths.add(deletePath);
      actions.push({
        type: "delete",
        path: deletePath,
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const addPath = normalizePatchPath({ path: line.slice("*** Add File: ".length) });
      const previous = actions.at(-1);
      const replacesDeletedPath = previous?.type === "delete" && previous.path === addPath;
      if (seenPaths.has(addPath) && !replacesDeletedPath) {
        throw new DiffError(`Add File Error: Duplicate Path: ${addPath}`);
      }
      seenPaths.add(addPath);
      const state: ParserState = {
        lines,
        index: index + 1,
        fuzz: 0,
      };
      const action = parseAddFile({ state });
      actions.push({
        type: "add",
        path: addPath,
        newFile: action.newFile,
      });
      index = state.index;
      continue;
    }

    throw new DiffError(
      `Invalid patch hunk on line ${lineNumber}: '${line}' is not a valid hunk header. Valid hunk headers: ${VALID_HUNK_HEADERS}`,
    );
  }

  if (actions.length === 0) {
    throw new DiffError("No files were modified.");
  }

  return actions;
}
