---
release: minor
---

### Added

- `followup.ts deploy-run <run-id>` reads a workflow run a deploy arm waits
  for and says whether it will settle by itself: `finished`, `moving`, or
  `stuck` when it has had no jobs past a bound (30 minutes, `--stuck-after`)
  and the finished runs of its workflow before it all ended cancelled, the
  sign of a held concurrency group. The follow-up records a stuck deploy as
  a step owed by a person and finishes its other arms, instead of waiting
  until the dispatcher hands the whole follow-up to a person.

### Fixed

- A dispatched follow-up whose deploy arm stayed pending past
  `dispatch.followup_within` was raised for a person even when the deploy
  had since finished, because only release tags were read again. A pending
  arm that links to its deploy run
  (`https://github.com/<owner>/<repo>/actions/runs/<id>`) now has that run
  read again before a person is told: a finished run runs the follow-up once
  more, and a pass naming a newer run starts a fresh window, as a newer
  release tag does.
