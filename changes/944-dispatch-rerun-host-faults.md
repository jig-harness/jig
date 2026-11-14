---
release: minor
---

### Added

- The dispatcher runs a follow-up again once when its pass could not record
  its result on the host, as it already did for a pass that died: whatever
  the pass said and however long ago, and never with the question the pass
  asked about the dispatcher's database. `jig dispatch result` now exits `4`
  when the state database refuses the write, keeps the evidence of the
  attempt outside the database, and tells the pass to stop without asking a
  person; the wrapper keeps the same evidence when it cannot record the
  stage's exit. Both runs again, a death's and an unwritten result's, wait
  for the host's health check to pass (`jig doctor dispatch`'s last run):
  while it fails the follow-up is held with nothing notified, and the host's
  own `ticks-failing` or `repository-failing` notice is what a person sees.
  It stays one run again per follow-up, counted against the pull request's
  recovery budget
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
- `failures.rerun_died` in the machine's dispatch file (`1` by default, `0`
  or `1`): `0` hands a follow-up whose pass died or could not record its
  result to a person instead of running it again.

### Changed

- A pickup whose result the host could not write raises no question for a
  person: its end is logged as a stage that ended without a result, and the
  host's health check reports the cause.
