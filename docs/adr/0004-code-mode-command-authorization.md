# Authorize nested commands individually

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implementation follows in #296–#302.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

Apply the existing bash-gate policy to each actual nested command, with independent authorization records, rather than approving an entire JavaScript cell or batch. Serialize human permission dialogs while allowing independent reviews and authorized commands to proceed; recheck session allowances before displaying queued requests. Cell cancellation invalidates pending approvals so late approval cannot start a process.

Preserve the existing policy scope of authorizing command launches; `write_stdin` polling and interactive input remain outside command classification. A denial rejects that nested call without directly revoking unrelated authorizations or cancelling sibling calls. Preserve Codex's native rejection and cleanup contract: if an unhandled rejection ends the cell, unfinished sibling delegates can be cancelled by runtime cleanup. Do not change denials into successful structured values or add bespoke batching instructions to promise stronger isolation than Codex provides.

Extract one callable authorization path shared by the ordinary Pi hook and nested dispatcher. Validate constructed arguments, then authorize each actual command with a unique nested call ID before process creation. Preserve subagent broker behavior and reuse #286’s host escalation seam if available. Bash-gate is not Codex sandbox enforcement: omit unsupported permission-profile, justification, and prefix-rule arguments rather than accepting inert controls.
