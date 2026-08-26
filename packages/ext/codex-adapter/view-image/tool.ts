import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fitLine, sanitizeSingleLine } from "../../subagents/ui/text-lines.js";
import { runBundledTool, type RunBundledToolOptions } from "../native/runner.js";
import { getBundledViewImagePath } from "./binary.js";

const parameters = Type.Object(
  { path: Type.String({ description: "Path to the local image file" }) },
  { additionalProperties: false },
);

type NativeRunner = (options: RunBundledToolOptions) => ReturnType<typeof runBundledTool>;

export interface ViewImageDetails {
  path: string;
}

export interface CreateViewImageToolOptions {
  /** `null` models a platform where no bundled helper is available. */
  binaryPath?: string | null | undefined;
  runNative?: NativeRunner | undefined;
}

function normalizeImagePath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function parseViewImageOutput(stdout: string): {
  type: "image";
  data: string;
  mimeType: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("view_image did not return structured image output");
  }
  if (!value || typeof value !== "object") {
    throw new Error("view_image did not return structured image output");
  }
  const { image_url: imageUrl, detail } = value as Record<string, unknown>;
  const match =
    typeof imageUrl === "string"
      ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl)
      : null;
  const mimeType = match?.[1];
  const data = match?.[2];
  if (!mimeType || !data || detail !== "original" || data.length % 4 !== 0) {
    throw new Error("view_image did not return structured image output");
  }
  return { type: "image", mimeType, data };
}

export function createViewImageTool(
  options: CreateViewImageToolOptions = {},
): ToolDefinition<typeof parameters, ViewImageDetails> {
  return {
    name: "view_image",
    label: "view_image",
    description: "Decode and view a local PNG, JPEG, GIF, or WebP image.",
    promptSnippet: "Decode and view a local image file",
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const path = normalizeImagePath(params.path);
      const binary =
        options.binaryPath === undefined ? getBundledViewImagePath() : options.binaryPath;
      if (!binary) {
        throw new Error(
          `view_image native executable is not bundled for ${process.platform}-${process.arch}`,
        );
      }
      const child = await (options.runNative ?? runBundledTool)({
        binary,
        args: [JSON.stringify({ path })],
        cwd,
        signal,
        label: "view_image",
      });
      if (child.status !== 0) {
        const detail = (child.stderr || child.stdout || "view_image failed").trim();
        throw new Error(`${detail}. Use exec_command for text files`);
      }
      return {
        content: [parseViewImageOutput(child.stdout)],
        details: { path },
      };
    },
    renderCall(args, theme) {
      const path = sanitizeSingleLine(args.path);
      const summary = theme.bold("View") + theme.fg("accent", path ? ` ${path}` : " ...");
      return {
        render: (width: number) => [fitLine(summary, width)],
        invalidate() {},
      };
    },
  };
}

export function registerViewImageTool(pi: ExtensionAPI): void {
  pi.registerTool(createViewImageTool());
}
