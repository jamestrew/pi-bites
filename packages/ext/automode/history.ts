import { createHash, randomUUID } from "node:crypto";
import type { Message, Tool } from "@earendil-works/pi-ai";

import { approximateTokens } from "./context-budget.js";

interface Cursor {
  length: number;
  hash: string;
}

function cursor(entries: readonly unknown[], length = entries.length): Cursor {
  return {
    length,
    hash: createHash("sha256")
      .update(JSON.stringify(entries.slice(0, length)))
      .digest("hex"),
  };
}

function extendsCursor(entries: readonly unknown[], previous: Cursor): boolean {
  return (
    entries.length >= previous.length && cursor(entries, previous.length).hash === previous.hash
  );
}

interface Snapshot {
  key: string;
  context: Cursor;
  branch: Cursor;
}

interface History extends Snapshot {
  scope: string;
  sessionId: string;
  messages: Message[];
}

export const REVIEW_OUTPUT_TOKENS = 1_024;

export class ReviewerHistory {
  private generation = 0;
  private committed?: History;
  private pending?: Snapshot;

  reset(): void {
    this.generation++;
    this.committed = undefined;
    this.pending = undefined;
  }

  begin(input: {
    key: string;
    scope: string;
    context: readonly unknown[];
    branch: readonly unknown[];
    systemPrompt: string;
    contextWindow: number;
    outputReserve: number;
    tools?: Tool[];
    readOnly: boolean;
    prompt: (contextOffset: number, branchOffset: number, availableTokens: number) => string;
  }) {
    const compatible = (snapshot: Snapshot) =>
      snapshot.key === input.key &&
      extendsCursor(input.context, snapshot.context) &&
      extendsCursor(input.branch, snapshot.branch);
    if (
      !input.readOnly &&
      ((this.committed && !compatible(this.committed)) ||
        (this.pending && !compatible(this.pending)))
    )
      this.reset();

    // Only the parent review that acquires the idle trunk can advance it.
    // Busy and forwarded reviews borrow the committed prefix but never promote.
    const canCommit = !input.readOnly && !this.pending;
    let previous =
      this.committed?.scope === input.scope && compatible(this.committed)
        ? this.committed
        : undefined;
    const limit = input.contextWindow - input.outputReserve - 256;
    const fits = (messages: Message[]) =>
      approximateTokens(
        JSON.stringify({
          systemPrompt: input.systemPrompt,
          messages,
          tools: input.tools,
        }),
      ) +
        32 * (messages.length + 1) <=
      limit;
    const build = (): Message[] => [
      ...structuredClone(previous?.messages ?? []),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: input.prompt(
              previous?.context.length ?? 0,
              previous?.branch.length ?? 0,
              limit -
                approximateTokens(
                  JSON.stringify({
                    systemPrompt: input.systemPrompt,
                    tools: input.tools,
                    messages: previous?.messages ?? [],
                  }),
                ) -
                32 * ((previous?.messages.length ?? 0) + 2),
            ),
          },
        ],
        timestamp: Date.now(),
      },
    ];
    let messages = build();
    if (!fits(messages) && previous) {
      previous = undefined;
      messages = build();
    }
    if (!fits(messages))
      throw new Error(
        "Reviewer request exceeds the whole-request budget; pending action was not truncated",
      );

    const snapshot: Snapshot = {
      key: input.key,
      context: cursor(input.context),
      branch: cursor(input.branch),
    };
    const generation = this.generation;
    const sessionId = previous?.sessionId ?? `pi-bites-reviewer-${randomUUID()}`;
    if (canCommit) this.pending = snapshot;
    return {
      messages,
      sessionId,
      assertCurrent: (context: readonly unknown[], branch: readonly unknown[]) => {
        if (
          generation !== this.generation ||
          !extendsCursor(context, snapshot.context) ||
          !extendsCursor(branch, snapshot.branch)
        ) {
          throw new Error("Reviewer context changed before assessment completed");
        }
      },
      assertFits: (messages: Message[]) => {
        if (!fits(messages)) throw new Error("Reviewer request exceeds the whole-request budget");
      },
      commit: (messages: Message[]) => {
        if (canCommit && generation === this.generation && this.pending === snapshot) {
          // Never mutate the array sent to an in-flight provider request.
          const completed = structuredClone(messages);
          this.committed = fits(completed)
            ? { ...snapshot, scope: input.scope, sessionId, messages: completed }
            : undefined;
        }
      },
      finish: () => {
        if (this.pending === snapshot) this.pending = undefined;
      },
    };
  }
}
