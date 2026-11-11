---
release: minor
---

### Changed

- A dispatched follow-up no longer fails on a step only a person can take
  after the merge (a live check against a real service, a rollout to another
  repository, an organization's setting, an operational action, a failed
  release gate): its pass reports the step as owed, files it, and records
  done. Two routine question classes join `local-leftover`: `person-owed`,
  answered by reporting and filing the step, and `drafted-items`, answered by
  filing the follow-up items the pass drafted. A follow-up that stops on
  either is run again once with that answer instead of waiting for a person.
