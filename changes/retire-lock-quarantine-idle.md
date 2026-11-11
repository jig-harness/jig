---
release: patch
---

### Fixed

- The drive state reaper retires the displaced file-lock quarantine entries of
  the releases before the database (`<lock>.stale.<generation>`) with
  `--delete`, instead of only reporting them: once no lock of the earlier
  layout is present, none of its state, lease, driver or claim files was
  written in the last 24 hours, and no entry is younger than that. A clone
  that was never imported is covered too. The README's upgrade section says
  when they go.
