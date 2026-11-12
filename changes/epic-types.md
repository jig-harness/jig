---
release: minor
---

### Added

- `issue_tracker.labels.epic_types` (optional, Jira and GitHub) lists issue
  types, such as `[Epic]`, whose issues are epics as if they carried the epic
  label: they need no size, a batch never takes them, a served claim walks
  their children and their closing waits for an acceptance verdict. A read
  of the issues carrying the epic label takes them too (on Jira
  `labels = "epic" OR issuetype in (…)`, on GitHub a second read by issue
  type), and the label is never written on them. `get_issue.ts` prints
  `isEpic` for every issue, and `tracker.ts labels` prints the list beside
  `epic`. Linear has no issue types, so there it marks nothing; unset, an
  epic is the label alone, as before.

### Changed

- Every skill now asks one test whether an issue is an epic, the tracker
  interface's `isEpic`, so the epic label matches ignoring case everywhere,
  as the filing check and the weekly sweep already did.
