---
release: minor
---

The CI hold gets a second form, for a repository whose labels change often: a
label change no longer has to run the whole pipeline.

### Added

- M13's CI hold can be started by a small workflow that reacts to the hold label
  alone and dispatches the pipeline on both transitions, saying whether the pull
  request is held. No other label then starts or cancels a run, which is what a
  repository running the dispatcher's labels wants: one state change there is
  two label events, and each used to start a full run that cancelled the one
  before. M13's README says when to use which form, and its `mappings.md` gives
  the shape and its limits: the dispatched run must test the pull request's
  merge, and a pull request from a fork cannot be dispatched. A repository
  whose workflows list both label events needs no change.

### Changed

- The workflow-convention lint accepts both forms under `ci-hold-events`,
  `ci-hold-guard` and `ci-hold-sentinel`, and fails a workflow that drops its
  label events with no sibling that dispatches it.
- The audit's `ci-hold-fails-held-heads` and `ci-hold-shape-linted` criteria
  accept both forms.
- The `github-actions` skill no longer reports a run dispatched in place of a
  pull request's own for sharing that pull request's concurrency group.
