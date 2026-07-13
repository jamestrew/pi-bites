---
description: Fix one cumulative strict TypeScript lint rule
argument-hint: "<step 1-6>"
---

Work on strict-types step $1 from the plan below. Complete the step end to end.

# Goal

Enable and fix the selected rule across non-test source. Work producer-first: remove the declaration or boundary that introduces `any`, rather than patching each downstream access. Preserve all rules completed in earlier steps.

Tests are intentionally excluded by the existing `.oxlintrc.jsonc` overrides. Do not change those overrides.

# Rule order

Rules are cumulative. Enable the selected rule and leave all earlier rules enabled at `"error"`.

1. `typescript/no-explicit-any` — remove known `any` producers.
2. `typescript/no-unsafe-assignment` — find inferred, imported, and SDK-origin `any` entering local values.
3. `typescript/no-unsafe-return` — prevent functions from leaking `any` to callers.
4. `typescript/no-unsafe-argument` — prevent `any` from crossing typed call boundaries.
5. `typescript/no-unsafe-member-access` — remove unsafe property access after upstream producers are fixed.
6. `typescript/no-unsafe-call` — remove calls whose callable type remains unsafe.

If `$1` is not an integer from 1 through 6, stop and ask for a valid step.

# Workflow

1. Read `.oxlintrc.jsonc`. Enable the selected rule at `"error"`; ensure all earlier rules remain enabled. Leave later rules disabled.
2. Run `scripts/strict-types-report.sh` to group current diagnostics by rule and file.
3. Inspect the reported files and trace shared type producers and their callers before editing.
4. Choose execution mode:
   - If the report contains only a few files or errors, fix all of them directly.
   - If it is large, divide it into coherent, disjoint file clusters. Cluster a shared producer with its closely related callers; do not split one type seam across agents.
   - Launch general subagents for independent clusters in parallel in one tool-call message. Give every agent an explicit file allowlist. Agents may edit only their assigned files, must not edit `.oxlintrc.jsonc`, and must run `bunx oxlint <assigned-files> -f unix` before returning.
   - Keep shared files in one cluster only. Handle any file that cannot be assigned without overlap in the parent agent.
5. For each direct or delegated cluster:
   - Find the originating type declaration or trust boundary.
   - Use the SDK's real exported type when one exists.
   - For genuinely unknown-shaped input, use `unknown` and narrow at first use.
   - Never replace `any` with a blind assertion merely to satisfy lint.
   - If the SDK cannot be narrowed without an assertion, use the narrowest justified assertion and add `// TODO(strict-types)` so the later `no-unsafe-type-assertion` phase can inventory it.
   - Sweep adjacent `as any`, `any[]`, `Record<string, any>`, and related declarations in the assigned files while the type seam is understood.
   - Keep the diff scoped; do not add abstractions or unrelated cleanup.
6. After subagents finish, inspect their actual diffs and verify they touched only assigned files. Resolve remaining diagnostics yourself.
7. Run the compact targeted check while iterating:

   ```bash
   bunx oxlint path/to/file.ts path/to/other.ts -f unix
   ```

8. Re-run `scripts/strict-types-report.sh`. The selected rule and all earlier rules must report zero diagnostics.
9. Run final validation:

   ```bash
   bun check
   ```

Do not declare completion unless `bun check` passes. Report the enabled rule, files changed, and validation result concisely.

# Rule-specific handling

## 1. `no-explicit-any`

Start with explicit producers: parameter annotations, generic arguments, assertions, arrays, and records. Typical changes include dropping `catch (error: any)` so strict mode infers `unknown`, replacing untyped extension callbacks with SDK context types, and finding the real generic argument for types such as `Model<any>`.

Do not mechanically turn `any` into `unknown`; follow each value to its first use and add the smallest real narrowing required.

## 2. `no-unsafe-assignment`

An assignment diagnostic often points downstream of the defect. Trace the right-hand side to the imported declaration, callback signature, parser boundary, or SDK generic that produced `any`. Fix that producer once rather than annotating every destination.

## 3. `no-unsafe-return`

Inspect the function's callers and establish its truthful return type. Narrow before returning. Do not hide an unsafe return behind a return annotation or broad assertion.

## 4. `no-unsafe-argument`

Trace the argument expression backward. Correct or narrow the value before the call; do not cast independently at each call site. Repeated failures usually indicate one shared producer.

## 5. `no-unsafe-member-access`

Treat property access as a symptom. Prefer discriminated unions, `typeof`, `instanceof`, `Array.isArray`, or a small structural guard at a genuine boundary. Avoid chains of property assertions.

## 6. `no-unsafe-call`

Establish that the value is callable and give it the narrowest accurate function signature. For unknown external input, check `typeof value === "function"`; for local or SDK values, fix the declaration that erased the callable type.

# Useful commands

Grouped report:

```bash
scripts/strict-types-report.sh
```

Compact diagnostics for a cluster:

```bash
bunx oxlint path/to/files -f unix
```

Search for adjacent explicit `any` forms:

```bash
rg -n '\bany\b|as any|any\[\]|Record<string, any>' path/to/files
```
