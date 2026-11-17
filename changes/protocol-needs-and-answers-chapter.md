---
release: minor
---

### Added

- The Jig Protocol has a provisional chapter on needs and structured
  answers
  ([plugin/protocol/needs-and-answers.md](../plugin/protocol/needs-and-answers.md)):
  every field of the decision record (`parked-decision/v1`) a park, a
  dispatched session's result or the dispatcher's tick frames for a person,
  the `answer <key>:` and `note <key>:` lines an answer is written in, the
  forms `approve` and `choose <option>`, how an answer's text is normalized
  before it is compared, the limits on an answer, a digest and a decision,
  the act a need asks of a person and the act of each decision class Jig
  knows, and the keys and options of the dispatcher's own framings. Its data
  file, `plugin/protocol/data/needs-and-answers.json`, and the decision
  record's JSON Schema, `plugin/protocol/schemas/parked-decision.json`,
  carry them for a dashboard, a workspace app's panel or any program that
  shows a decision and writes an answer. The decision record's stored
  reader now checks a record against the same description the schema is
  generated from, and reads every record it read before.
  **Consumer action:** none.
