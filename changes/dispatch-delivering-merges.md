---
release: patch
---

### Fixed

- Dispatch releases an execution plan's merge conflict edge when the predecessor's linked pull request has merged into the integration branch and changed a declared conflict file. Direct merge evidence works before follow-up activation; unreadable evidence or a later open predecessor pull request keeps the edge held with a reason.
