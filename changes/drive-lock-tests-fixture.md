---
release: patch
---

### Fixed

- The drive-pr driver-lock tests run each drive in a scratch repository
  with its own remote, so their result no longer depends on the checkout
  running them: they pass on a branch with commits not yet pushed or just
  amended, where many of them used to fail.
