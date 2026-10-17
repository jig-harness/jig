---
release: minor
---

The audit costs what the profile asks for, runs unattended, and splits its
scoring across agents with tools to put the parts together.

### Added

- `score.ts --draft --profile <id>` leaves the criteria beyond that profile's
  target *not examined*: a new score that meets no bar, is never a gap, and
  shows on the [audit sheet](../plugin/skills/audit/references/report-sheet.md)
  as not examined. On a re-audit the prior record's profile is the default;
  `--examine-all` scores everything; a `--profile` other than the prior
  record's adds its targets to the declared profile's. `--at <rev>` scores a
  commit from a temporary worktree while the checkout has changes, and keeps
  it for the surveys to read until the record is done.
- `record.ts fill` writes answers (`M1/<id>: <score> | <evidence>`, or JSON)
  into a draft, and `record.ts merge` combines copies of a draft that several
  agents scored; both refuse unknown criteria, a probe's score changed, and
  answers that disagree. The survey prompts return their modules' answers in
  that form, read step 1's host facts instead of querying the host again,
  and leave drift to one pass.
- `record.ts summary --profile <id>` and `report.ts validate|render --profile
  <id>` show a record under another profile without changing it.
- The report source gains `left_on_purpose` (gaps the auditor chose to
  leave, with the reason), a recommendation's `status: "applied"` with
  `applied_in` (shown as done, asking no decision) and `needs: "host-admin"`.
  The sheet shows the other profile the facts could support near a
  boundary, with how many modules would be at target under it.
- Configuration fit reports a checkout behind its integration branch, a
  leftover `groundwork` overlay or references to the old plugin, `.context/`
  not ignored, an `issue_tracker.file_command` that resolves nowhere, a
  `gates.command` that runs less than CI, a gate tool an agent would need
  permission for, and an AI reviewer posting without being named in
  `review.reviewer_app` (or named and never posting).
- `record.ts check` warns of evidence naming a path or line the audited
  commit does not have.
- The audit skill says what to do unattended: never block on a question, and
  apply, without the team's decisions, only drift fixes and written rules.
  It names a private scratch folder per audit (`mktemp -d`, or one under `.context/jig-audit/`).
- New criterion `M0/instruction-file-stays-small`, split from
  `M0/universal-instruction-file`, which now asks only that the file exists
  and is vendor-neutral. Many more criteria carry probes, and probe lists
  cover more CI providers, hook managers and dependency updaters. A probe
  can cap a criterion's rung instead of ruling it out (`mechanical: <probe>`):
  without CI, a check run only locally still scores `advisory`. The draft
  records the ceiling as the entry's `at_most`, and `record.ts fill`, `merge`
  and `check` refuse a score above it.

### Changed

- **Breaking**: `record.ts check`, `compare` and `summary`, and `report.ts
  validate` and `render`, refuse a record (a prior or older one included)
  whose commit the repository does not hold, and a report whose repository
  name, owner included, none of its remotes names; run the audit from a full
  clone of the audited repository. `report.ts --other-repository` renders
  another repository's audit on purpose.
- With the forge readable, the integration branch is the forge's default
  branch, and a local `origin/HEAD` that disagrees is reported. With at most
  one person committing in the last year, the suggested profile is Solo/Lite
  even where CI deploys. The tracker team suggestion counts issue keys in
  branch names and commit subjects too.
- The criteria say when to score `expected-absent` (the shape rules the
  practice out for good) and when to score what the repository does without
  the module a practice presupposes; a
  check only in a local hook is `advisory`; a host plan that cannot require
  checks is scored advisory with a local hook as the ceiling; shapes include
  `infrastructure`.
