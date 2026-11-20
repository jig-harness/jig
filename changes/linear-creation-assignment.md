---
release: patch
---

### Fixed

- `jig dispatch` now starts a Linear issue that was created already assigned,
  instead of refusing it on every tick with "its history holds no assignment".
  Linear writes no history entry for an assignee given at creation, so when no
  entry ever changed an issue's assignee, its creator is read as the assigner
  and passes the same test any assigner passes: a non-guest member of the team
  starts the pickup; an integration, an automation, a guest or someone outside
  the team starts nothing, and the item's reason says it was created assigned
  by them. The read adds no request. An issue that is stranded already is read
  again when its update time next moves.
