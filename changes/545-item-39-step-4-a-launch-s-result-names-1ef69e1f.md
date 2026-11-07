---
release: minor
---

### Added

- Launch outcomes name the next owner, and `jig ask` shows the handoff as
  `last.next`: a station address, a person and their act, or nobody with a
  reason. A converged drive hands to a maintainer to merge, and a completed
  follow-up has no next owner. Older records remain readable. Late pickup
  results refresh the outcome and its text archive; malformed stored
  handoffs remain unknown. Late failures preserve the recorded question,
  and archive refreshes read revisions in bounded batches.

### Changed

- **Breaking:** a completed pickup must report `jig dispatch result <record>
  <token> done --pr <number>`, or `done --none "<reason>"` when no pull request
  was needed. Update commands that report a pickup's result; new launch
  prompts include these arguments. Follow-up and failed-result commands keep
  their existing form.
