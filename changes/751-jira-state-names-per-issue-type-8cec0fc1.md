---
release: minor
---

### Added

- Jira workflows can use state names per issue type through
  `issue_tracker.jira.states_by_type`. Each type overlays the repository's
  state map; `null` marks a state absent, so its move is skipped and reported.
  Parent roll-up uses each child's workflow and the parent's own target,
  and `tracker.ts states` prints every configured type's effective map.
