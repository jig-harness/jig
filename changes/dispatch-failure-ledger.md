---
release: minor
---

### Added

- `jig dispatch --apply` counts what fails in a row: each pull request's
  dispatch label write, each notification's delivery, each nudge the
  runtime refused, and this host's claim ends and follow-up marker answers;
  each repository's turn (refused, stopped by a defect, or a record that did
  not read); and this host's ticks of one scope that exited 1. An action
  that failed twice in a row backs off, reported as waiting with its count
  and next try, from 2 minutes doubling to an hour, instead of being tried
  every tick. Once a row reaches 3 failures in a row a person is told, once
  and then on `dispatch.renotify_after`, with what failed, how many times,
  since when and the last reason (causes `action-failing`,
  `repository-failing` and `ticks-failing`). A success, or the action
  leaving the plan, clears the row and retires the notice. The machine
  file's new `failures` settings (`backoff`, `backoff_max`, `notify_after`)
  tune it, and each receipt lists the rows backing off and the rows a
  person was told of under `failures`. Launches are not counted: their
  launch records already count attempts.
