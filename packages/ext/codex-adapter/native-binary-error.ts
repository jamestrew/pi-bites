import { existsSync } from "node:fs";

const VENDOR_SOURCE_BY_HELPER: Record<string, string> = {
  exec_bridge: "exec",
  view_image: "view-image",
  web_run: "web-run",
};

function recovery(helper: string): string {
  const source = VENDOR_SOURCE_BY_HELPER[helper] ?? "apply-patch";
  return `Rebuild it from packages/ext/codex-adapter/vendor/${source}, replace the bundled executable, then run \`/reload\``;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function nativeBinaryRecoveryMessage(
  helper: string,
  error: unknown,
  options: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
  } = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const message = errorMessage(error);
  const loaderFailure =
    /Could not start dynamically linked executable|NixOS cannot run dynamically linked|stub-ld|(?:version [`']?)?GLIBC_[0-9.]+[`']? not found|error while loading shared libraries: [^\n]+: cannot open shared object file/i.test(
      message,
    );
  const startupPipeFailure =
    options.startupWriteFailure === true &&
    (errorCode(error) === "EPIPE" || /\bEPIPE\b|broken pipe/i.test(message));
  const missingInterpreter =
    errorCode(error) === "ENOENT" && !!options.binaryPath && existsSync(options.binaryPath);
  const missingExecutable =
    errorCode(error) === "ENOENT" && !!options.binaryPath && !existsSync(options.binaryPath);
  const unusableExecutable =
    !!options.binaryPath && ["EACCES", "ENOEXEC"].includes(errorCode(error) ?? "");
  if (missingExecutable) {
    return `${helper} native executable is not available at ${options.binaryPath}. ${recovery(helper)}`;
  }
  if (!loaderFailure && !startupPipeFailure && !missingInterpreter && !unusableExecutable) {
    return undefined;
  }
  return `${helper} cannot run on this system. ${recovery(helper)}`;
}

export function formatNativeBinaryError(
  helper: string,
  error: unknown,
  options?: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
  },
): string {
  return nativeBinaryRecoveryMessage(helper, error, options) ?? errorMessage(error);
}
