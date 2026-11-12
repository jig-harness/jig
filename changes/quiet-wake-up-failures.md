---
release: patch
---

### Fixed

- A repository that `jig dispatch` rarely wakes no longer keeps asking a
  person about failing ticks long after their cause is gone. A tick that
  read the repository and exited 0 now quiets that repository's wake-up row
  in the failure ledger: the row keeps its count, but nothing notifies it
  or lists it as escalated until a wake-up of that repository fails again,
  which counts on from where it stopped.
