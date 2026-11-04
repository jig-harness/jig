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

- **Breaking** for a workflow of the hold whose job conditions read the
  event's action or label: the lint's `ci-hold-guard` now fails a job whose
  `if:` has such a term (`github.event.action`, `github.event.label`, in any
  spelling) other than the mirror's skip term, since a job skipped on some
  events and not others can turn a failing head into a passing one. Test the
  pull request's label set instead, as the hold asks; a workflow that already
  does is unaffected.
- The audit's `ci-hold-fails-held-heads` and `ci-hold-shape-linted` criteria
  accept the mirror run beside real CI on every label event.
