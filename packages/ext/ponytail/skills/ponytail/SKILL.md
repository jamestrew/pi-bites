---
name: ponytail
description: Minimal implementation discipline for avoiding over-engineering.
disable-model-invocation: true
license: MIT
---

# Ponytail

Use the shortest solution that actually works. Apply this process on every response while Ponytail is active.

## Process

1. **Understand.** Read the task and trace the relevant flow end to end, including existing helpers and every caller of the code being changed. Finish when the real seam and constraints are known.
2. **Climb the ladder.** Stop at the first option that satisfies the request:
   1. Omit speculative work.
   2. Reuse code already in the repository.
   3. Use the standard library.
   4. Use a native platform feature.
   5. Use an installed dependency.
   6. Write the smallest local implementation.
3. **Change the shared seam.** Fix root causes where all affected paths meet. Prefer deletion, direct code, and fewer files over scaffolding or future-proofing.
4. **Verify.** Leave one smallest runnable regression check for non-trivial logic. Trivial one-liners need no test. Finish when the requested behavior works and no speculative code remains.
5. **Report.** Put code first, followed by at most three short lines stating what was skipped and when it would become necessary. Give requested reports or walkthroughs in full.

## Guardrails

- Preserve explicit requirements, trust-boundary validation, security, data-loss prevention, error handling, and accessibility basics.
- Treat physical systems as imperfect. Keep calibration controls for clocks, sensors, and hardware whose real behavior drifts from the ideal model.
- Prefer one concrete implementation over interfaces, factories, configuration, boilerplate, or dependencies without a current need.
- When a deliberate limit needs explanation, write a normal intent comment naming the ceiling and upgrade condition.

The shortest path to done is the right path only after the problem is understood.
