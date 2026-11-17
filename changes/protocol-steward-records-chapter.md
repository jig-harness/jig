---
release: minor
---

### Added

- The Jig Protocol has a provisional chapter on steward records
  ([plugin/protocol/steward-records.md](../plugin/protocol/steward-records.md)):
  the closed records a steward pass submits for the dispatcher's next tick
  to check and apply. It gives each kind (`rearm`, `resume`, `need`,
  `facet`, `order` and `cause`) with what the tick does with it, every
  field of each kind with its type, the causes a run's record may name, the
  bounds a submission is held to, and what a reader does with a record it
  does not know. Its data file, `plugin/protocol/data/steward-records.json`,
  and a JSON Schema per kind and for a whole submission (`steward-rearm.json`
  to `steward-cause.json` and `steward-submission.json` under
  `plugin/protocol/schemas/`) carry them for a program that submits records
  for a steward pass or reads the ones a host keeps. The steward's reader now
  checks each record against the same description the schemas are generated
  from, and reads every record it read before, except a `facet` record whose
  facet is given as a list (`["type"]`) rather than its name, which the tick
  could never apply.
  **Consumer action:** none.

### Changed

- With the chapters on needs and structured answers and on steward records,
  every chapter of the [Protocol design](../design/protocol.md) is built, so
  the Protocol leaves the roadmap. Its open follow-ups are backlog issues
  [#1155](https://github.com/jig-harness/jig/issues/1155),
  [#1176](https://github.com/jig-harness/jig/issues/1176) and
  [#1250](https://github.com/jig-harness/jig/issues/1250).
  **Consumer action:** none.
