---
release: patch
---

### Fixed

- A dead drive whose worktree was removed can be taken over from the remote head. The doctor reports `DEAD` for a missing tree; existing trees that cannot be inspected still refuse takeover.
