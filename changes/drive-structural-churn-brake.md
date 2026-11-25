---
release: minor
---

### Added

- A drive now parks itself on structural churn instead of spending rounds
  that converge on nothing. Before a round's pass, the drive checks the rounds
  recorded since it last parked this way. It parks with `HITL_PARKED` when one
  file drew findings in each of the last `drive.churn_rounds` consecutive
  rounds (4 by default), none of them `high` or `blocker`, with the file
  changing between each pair of consecutive reviewed heads. It also parks when
  a file returned to an earlier content after a different one. That check
  reads only the latest 12 recorded rounds, and a file's content is recorded
  only for the rounds where it drew a finding, so a file with no finding on
  the intermediate head escapes it; a round whose contents could not be read
  is no evidence either way. A head
  the reviewer has not reviewed is never judged. A round with a `high` or `blocker` finding never counts
  toward the same-file streak. The park's framed decision names the files and
  the rounds and offers **Ship as is and defer the rest**, **Constrain the
  scope** and **Continue driving**. Nothing is deferred until a person chooses.
  While the park stands, the drive runs no round, even with findings open;
  a pull request that conflicts with its base reports `PR_CONFLICTING`
  before the park, and the park that a conflicting round trips is recorded
  alongside it, as with any park
  ([drive-pr](../plugin/skills/drive-pr/README.md#the-structural-churn-park),
  [drive end states](../plugin/protocol/drive-exits.md#when-the-drive-parks-itself-on-structural-churn)).
- `drive.churn_rounds` in `.config/jig.yaml` sets the brake: `0` turns it
  off, or a whole number from 2 to 12. `DRIVE_PR_CHURN_ROUNDS` sets it for one
  run. Any other value stops the round as `INDETERMINATE`
  ([configuration](../plugin/CONFIGURATION.md#drive)).
- The `structural-churn` decision class, with the act Decide, in the
  [needs and structured answers](../plugin/protocol/needs-and-answers.md)
  chapter. It is kept even when a repository's `autonomy.park_classes`
  leaves it out, as `escalated`, `human-decision` and `human-thread` are.

### Changed

- `drive-state.ts record-paths` also takes one JSON object on stdin
  (`--stdin-json`), recording each round's severity and file contents beside
  its paths. The `--path` and `--stdin` forms work as before.

- A driven pull request reads `drive.churn_rounds` from its base branch's policy, so the change being driven cannot turn off its own brake.
