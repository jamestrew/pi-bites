import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

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

// Bound the entire serialized request, not just its transcript. One UTF-8 byte per
// token plus framing is deliberately conservative without a provider tokenizer.
// Reserve output separately; larger histories need provider-aware token counting.
const MAX_INPUT_BYTES = 96_000;
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
    isolated: boolean;
    prompt: (contextOffset: number, branchOffset: number) => string;
  }) {
    const compatible = (snapshot: Snapshot) =>
      snapshot.key === input.key &&
      extendsCursor(input.context, snapshot.context) &&
      extendsCursor(input.branch, snapshot.branch);
    if (
      !input.isolated &&
      ((this.committed && !compatible(this.committed)) ||
        (this.pending && !compatible(this.pending)))
    )
      this.reset();

    const isolated = input.isolated || !!this.pending;
    let previous = isolated || this.committed?.scope !== input.scope ? undefined : this.committed;
    const limit = Math.min(MAX_INPUT_BYTES, input.contextWindow - input.outputReserve);
    const fits = (messages: Message[]) =>
      Buffer.byteLength(JSON.stringify({ systemPrompt: input.systemPrompt, messages }), "utf8") +
        256 * (messages.length + 1) <=
      limit;
    const build = (): Message[] => [
      ...(previous?.messages ?? []),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: input.prompt(previous?.context.length ?? 0, previous?.branch.length ?? 0),
          },
        ],
        timestamp: Date.now(),
      },
    ];
    let messages = build();
    if (!fits(messages) && previous) {
      this.committed = undefined;
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
    if (!isolated) this.pending = snapshot;
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
      commit: (response: AssistantMessage) => {
        if (!isolated && generation === this.generation && this.pending === snapshot) {
          // Never mutate the array sent to an in-flight provider request.
          const completed = [...messages, structuredClone(response)];
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
