---
release: minor
---

### Fixed

- `jig doctor dispatch` no longer passes while every tick fails. A tick that
  a throw stops before its act phase, such as one whose state database is
  refused at the start, now writes a failed receipt, so `jig status` and
  `jig doctor` read that tick rather than an older successful one. The
  `dispatch:last-run` check names the latest tick's failure reason and, when
  more than one tick in a row failed, how many and since when.
