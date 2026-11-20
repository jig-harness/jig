---
release: minor
---

### Added

- `/jig:file-issue` hands a newly filed issue to the line when the filing
  names who takes it: `jig send pickup@<owner>/<name>#<KEY> assign` for the
  repository's factory identity, and the skill's `hand-off.ts` for a served
  person. Each writes the assignment only once the tracker's history records
  it, and the filing report says when it was written, or, when it was not,
  the command to run and the earliest time to run it. An issue already
  assigned is never changed. **Consumer action:** none.

### Fixed

- On Linear, an issue assigned within three minutes of its creation was
  never started: Linear leaves changes made in an issue's first three
  minutes out of its history, so the dispatcher found no assignment and
  refused the item on every tick. `jig send … assign` now waits until that
  window has passed before writing, and for an item already assigned to the
  factory identity whose history shows no assignment it refuses with the
  remedy (unassign it, then send again) instead of the bare "already
  assigned". The served-queue documentation and the operator skill say the
  same. **Consumer action:** advised at instructions. A runbook that assigns
  a Linear item to the factory identity or a served person right after
  filing it should wait three minutes, or unassign and assign it again
  after them.
