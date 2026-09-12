import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

const helper = "codex-code-mode-host";
const recovery =
  "Install the Code Mode dependency following packages/ext/codex-adapter/vendor/code-mode/README.md#manual-installation, then run `/reload`; or explicitly disable codexAdapter.";

export function getCodeModeHostPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) {
    throw new Error(
      `Unsupported Code Mode platform ${platform}-${arch}. Use Linux x64/arm64 or explicitly disable codexAdapter.`,
    );
  }
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const path = resolve(directory, helper);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Continue searching past missing or inaccessible PATH entries.
    }
  }
  throw new Error(`${helper} was not found executable on PATH. ${recovery}`);
}

/** Packaging probe only. The session-owned runtime client is implemented separately. */
export async function verifyCodeModeHost(binaryPath = getCodeModeHostPath()): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: "pipe" });
    let output = Buffer.alloc(0);
    let stderr = "";
    let failure: Error | undefined;
    let ready = false;
    const fail = (error: unknown) => {
      failure ??= new Error(
        `${helper}: ${error instanceof Error ? error.message : String(error)}. ${recovery}`,
      );
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new Error("Code Mode host startup timed out")), 5_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (output.length + chunk.length > 65540) {
        fail(new Error("Incompatible Code Mode host: oversized handshake"));
        return;
      }
      output = Buffer.concat([output, chunk]);
      if (output.length < 4) return;
      const length = output.readUInt32LE(0);
      if (length > 65536) {
        fail(new Error("Incompatible Code Mode host: oversized handshake"));
        return;
      }
      if (output.length < length + 4) return;
      try {
        const message = JSON.parse(output.subarray(4, length + 4).toString()) as Record<
          string,
          unknown
        >;
        if (
          ready ||
          output.length !== length + 4 ||
          message.type !== "connection/ready" ||
          message.selectedVersion !== 1 ||
          !Array.isArray(message.capabilities) ||
          !message.capabilities.every((value: unknown) => typeof value === "string")
        ) {
          throw new Error("Incompatible Code Mode host: expected protocol v1 handshake");
        }
        ready = true;
        output = Buffer.alloc(0);
        child.stdin.end();
      } catch (error) {
        fail(error);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!ready || output.length !== 0 || code !== 0)
        reject(
          new Error(
            `${helper} startup failed (exit ${code}, signal ${signal}): ${stderr}. ${recovery}`,
          ),
        );
      else resolve();
    });
    const body = Buffer.from(
      JSON.stringify({
        type: "connection/hello",
        supportedVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: [],
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
}
