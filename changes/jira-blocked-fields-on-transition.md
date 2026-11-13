---
release: patch
---

### Fixed

- On Jira, the drive-ledger projection now sends the `issue_tracker.jira.blocked_fields`
  the transition into the blocked status carries on its screen with the move itself, so a
  workflow whose transition requires the blocker reason accepts the move instead of refusing it
  before the fields were written. Fields not on the transition's screen are still written by an
  update after the move, and the return move is unchanged. A move Jira still refuses names the
  transition, Jira's message, and which fields went with it.
