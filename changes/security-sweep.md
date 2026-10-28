---
release: patch
---

### Fixed

- The replied-thread sweep and `triage-thread.ts` keep declined code-scanning findings open until their alerts are confirmed dismissed, and a `moot` open until its alert is fixed, closed or dismissed; `triage-thread.ts` exits `4` while one is not. A code-scanning `moot` is never held for a push, so a retry after its alert settles resolves it, and a thread GitHub's code scanning account opened whose alert cannot be identified stays open. A retry or `--cleanup-only` on a resolved code-scanning thread whose `moot` superseded an `accepted` reply releases that stale hold. `finish-round.ts` no longer refuses the push for such a thread, answered and waiting on its alert, so a `moot` resting on the round's own fix can be pushed.
