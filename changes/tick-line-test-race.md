---
release: patch
---

### Fixed

- The dispatcher's test of a tick whose dashboard line cannot be written now
  also checks that the tick launched its pull request and kept the launch
  record, so a regression that drops the launch no longer passes it.
