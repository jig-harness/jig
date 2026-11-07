---
release: patch
---

### Fixed

- The turn-budget guard recognizes Codex task and response records, avoiding hook errors and counting responses within each task. It rescans older parser checkpoints and reports malformed response records that would otherwise freeze the count.
