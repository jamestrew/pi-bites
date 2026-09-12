import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface NestedTrace {
  cellId: string;
  callId: string;
  cwd?: string;
  name: string;
  input: unknown;
  state: "approval" | "running" | "completed" | "error";
  result?: AgentToolResult<unknown>;
}

/** Presentation only: never appended to native/model result values. Oldest calls are evicted.
 * Text is bounded structurally so renderer details remain objects. Oversized images are omitted,
 * never truncated into invalid base64. Explicit image() output uses the independent native path.
 */
export class NestedTraces {
  private entries = new Map<string, { trace: NestedTrace; bytes: number }>();
  private bytes = 0;
  private version = 0;
  private listeners = new Set<(cellId: string) => void>();
  observe(cellId: string, update: () => void): { version: number; dispose(): void } {
    const version = ++this.version;
    const listener = (id: string) => {
      if (id === cellId) update();
    };
    this.listeners.add(listener);
    return {
      version,
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.listeners.clear();
  }
  forCell(cellId: string): NestedTrace[] {
    return [...this.entries.values()]
      .filter(({ trace }) => trace.cellId === cellId)
      .map(({ trace }) => structuredClone(trace));
  }
  record(trace: NestedTrace): void {
    let remaining = 64 * 1024;
    let nodes = 4096;
    const bound = (value: unknown, depth = 0): unknown => {
      if (--nodes < 0) return undefined;
      if (typeof value === "string") {
        const limit = Math.max(0, Math.min(8192, remaining));
        const text = value.length > limit ? `${value.slice(0, limit)}\n[Display truncated]` : value;
        remaining -= text.length;
        return text;
      }
      if (depth > 12) return undefined;
      if (Array.isArray(value)) return value.slice(0, 128).map((item) => bound(item, depth + 1));
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        if (object.type === "image" && typeof object.data === "string") {
          return object.data.length <= 8 * 1024 * 1024
            ? { ...object }
            : { type: "text", text: "[Image omitted from retained trace: size limit]" };
        }
        return Object.fromEntries(
          Object.entries(object)
            .slice(0, 128)
            .map(([key, item]) => [key, bound(item, depth + 1)]),
        );
      }
      return value;
    };
    const input = bound(trace.input);
    remaining = 64 * 1024;
    nodes = 4096;
    const result = trace.result
      ? { content: bound(trace.result.content), details: undefined as unknown }
      : undefined;
    remaining = 64 * 1024;
    nodes = 4096;
    if (result && trace.result) result.details = bound(trace.result.details);
    const bounded = { ...trace, input, result } as NestedTrace;
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    this.bytes -= this.entries.get(trace.callId)?.bytes ?? 0;
    this.entries.set(trace.callId, { trace: bounded, bytes });
    this.bytes += bytes;
    while (this.entries.size > 128 || this.bytes > 16 * 1024 * 1024) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      const [key, entry] = oldest;
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
    for (const listener of this.listeners) {
      try {
        listener(trace.cellId);
      } catch {
        /* Presentation must not reject a delegate. */
      }
    }
  }
}
