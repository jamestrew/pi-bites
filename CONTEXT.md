# Pi Bites

Pi Bites extends Pi with small interaction and context-management features.

## Language

**At-mention expansion**:
Model context produced from one successfully resolved `@path`, identified by its resolved path and optional line range. A directory listing is also an at-mention expansion.
_Avoid_: File dump, context dump

**Injected expansion**:
An at-mention expansion actually added to the active conversation context; invalid and unchanged mentions are not injected expansions.
_Avoid_: Triggered mention

**Unchanged expansion**:
An at-mention expansion whose model-visible content matches the last injected expansion with the same resolved path and line range since the active context was last rewritten.
_Avoid_: Unmodified file
