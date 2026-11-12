---
release: minor
---

### Added

- `file-issue`'s weekly sweep can leave issues where they are: with
  `file_issue.sweep.move: false` in `.config/jig.yaml`,
  `check-fields.ts check --yes` posts its comment on each incomplete issue
  and moves none back to triage, for a lane where only a person may move a
  ready issue back. An issue that already carries the comment's marker is
  passed over before the run's budget of 50 is counted, so a second run
  neither comments on it again nor spends its budget on it. `file_issue` is
  a new configuration section, documented in CONFIGURATION.md and checked by
  the audit.
