import { listProjectPaths } from "./fd-index.js";

export class PathIndex {
  private cached = new Map<string, string[]>();
  private pending = new Map<string, Promise<string[]>>();

  getPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const cached = this.cached.get(cwd);
    if (cached) return Promise.resolve(cached);

    const pending = this.pending.get(cwd);
    if (pending) return pending;

    return this.load(cwd, signal);
  }

  refresh(cwd: string, signal?: AbortSignal): Promise<string[]> {
    this.cached.delete(cwd);
    this.pending.delete(cwd);
    return this.load(cwd, signal);
  }

  clear(cwd?: string): void {
    if (cwd === undefined) {
      this.cached.clear();
      this.pending.clear();
      return;
    }

    this.cached.delete(cwd);
    this.pending.delete(cwd);
  }

  private load(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const promise = listProjectPaths(cwd, signal)
      .then((paths) => {
        this.cached.set(cwd, paths);
        return paths;
      })
      .finally(() => {
        if (this.pending.get(cwd) === promise) this.pending.delete(cwd);
      });

    this.pending.set(cwd, promise);
    return promise;
  }
}
