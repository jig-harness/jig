---
release: minor
---

### Added

- The [epic closure sweep](../plugin/skills/do-item/README.md#the-epic-closure-sweep)
  proposes closure for delivered scope, identifies unfinished work for the
  backlog, and records a person's reply as the waiver. It checks the plan
  and moves outstanding checks before closing an accepted epic.
  **Consumer action:** advised at configuration. To transfer person-only
  checks at epic closure, set `issue_tracker.person_checks` to the key of
  a standing open issue.
