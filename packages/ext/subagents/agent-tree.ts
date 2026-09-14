import type { AgentRecord } from "./types.js";

/** Stable graph queries shared by delegation, targeting and subtree invalidation. */
export function getAgentSessionId(record: AgentRecord): string | undefined {
  try {
    return record.session?.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

export class AgentTree {
  private maxDepth = 1;
  constructor(
    private agents: Map<string, AgentRecord>,
    private isClosing: (id: string) => boolean,
  ) {}
  setMaxDepth(depth: number): void {
    if (!Number.isInteger(depth) || depth < 0) throw new Error("Invalid agent depth limit");
    this.maxDepth = depth;
  }

  getMaxDepth(): number {
    return this.maxDepth;
  }

  containsSession(agentId: string, sessionId: string): boolean {
    let current = [...this.agents.values()].find(
      (record) => getAgentSessionId(record) === sessionId,
    );
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === agentId) return true;
      seen.add(current.id);
      const parentId = current.parentSessionId;
      current = [...this.agents.values()].find((record) => getAgentSessionId(record) === parentId);
    }
    return false;
  }

  rootSessionId(sessionId: string): string {
    const parent = [...this.agents.values()].find(
      (record) => getAgentSessionId(record) === sessionId,
    );
    return parent?.rootSessionId ?? parent?.parentSessionId ?? sessionId;
  }

  assertCanDelegate(sessionId: string): void {
    let depth = 0;
    let parent = [...this.agents.values()].find(
      (record) => getAgentSessionId(record) === sessionId,
    );
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent.id) || this.isClosing(parent.id))
        throw new Error("Subagent owner is closed");
      seen.add(parent.id);
      depth++;
      const parentSessionId = parent.parentSessionId;
      parent = [...this.agents.values()].find(
        (record) => getAgentSessionId(record) === parentSessionId,
      );
    }
    if (depth + 1 > this.maxDepth)
      throw new Error("Agent depth limit reached. Solve the task yourself.");
  }

  assertOwnerAvailable(parentId: string, rootId: string): void {
    if (parentId === rootId) return;
    const parent = [...this.agents.values()].find(
      (record) => getAgentSessionId(record) === parentId,
    );
    if (!parent || this.isClosing(parent.id)) throw new Error("Subagent owner is closed");
  }
}
