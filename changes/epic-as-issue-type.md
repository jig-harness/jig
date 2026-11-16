---
release: patch
---

### Changed

- A label taxonomy may list a type in a group's `not_required_on`, so a
  repository that keeps its epics as an issue type (`issue_tracker.labels.epic_types`)
  lifts the size requirement on the type itself, with no `epic` flag beside it.
  The lint's message for an unknown id now says "neither a flag nor a type".
