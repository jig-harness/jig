---
release: patch
---

### Fixed

- A dispatched drive or headless pass now records how it ended even when the
  host upgrades Jig during the stage to a release whose state database
  refuses older readers. The tick logs the launch by its real exit instead of
  "its wrapper is gone without an exit". If the wrapper still cannot record
  the exit, it says the stage ran and exits with the stage's own code instead
  of reporting that nothing was started.
- The dispatcher no longer counts a pickup or follow-up that ended normally
  while waiting (a follow-up whose release or deployment is still pending), or
  that stopped on a decision for a person, as a failure. The outcome log
  records these as `arm pending` and `parked for a person`; a parked run names
  who answers it and what they must do; and the dashboard, the recurring
  classes and the steward stop counting them as failures.
- The dispatch dashboard says a repository the dispatcher paused for its
  GitHub quota in one short line: what paused it, when it resumes and how old
  the data shown is, with the full detail on expanding the card. A repository
  lookup held by a rate limit no longer reads as the forge not knowing which
  repository it is.
