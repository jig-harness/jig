---
release: patch
---

### Fixed

- The drive-pr driver-lock tests that ran against the caller's checkout now
  use scratch repositories with their own remotes and isolated spawn
  environments. They pass on a branch with commits not yet pushed or just
  amended, and inside an active drive, where they used to fail.
