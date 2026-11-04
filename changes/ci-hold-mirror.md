---
release: minor
---

A label change no longer has to cost a full CI run, or cancel one, in a
repository that holds CI between review rounds.

### Added

- M13's CI hold can answer an event for any label but the hold's with a
  mirror run: the heavy jobs skip, the run takes a concurrency group of its
  own so it cancels nothing, and the required check repeats the newest real
  run's result on the same commit, failing whenever it cannot show that result
  passed. A repository whose labels change often, such as one running the
  dispatcher's labels, wants it: one change there removes one label and adds
  another, each its own event, and each event used to start a full run that
  cancelled the one before. M13's piece 7
  says why the run cannot simply skip, and `mappings.md` gives its shape on
  GitHub Actions. A repository whose workflows run real CI on every label
  event needs no change.
- The workflow-convention lint's `ci-hold-mirror` rule checks a workflow that
  skips on other labels' events: its own concurrency group, a `run-name` that
  marks the mirror run, a required job that runs and repeats the real result,
  and every heavy job skipped.

### Changed

- The lint's `ci-hold-guard` also fails a job whose `if:` decides on the label
  event itself (`github.event.label`, or a label action) in any form but the
  mirror's skip term: a job skipped on a label event can turn a failing head
  into a passing one. A workflow whose jobs test only the pull request's label
  set, as the hold asks, is unaffected.
- The audit's `ci-hold-fails-held-heads` and `ci-hold-shape-linted` criteria
  accept the mirror run beside real CI on every label event.
