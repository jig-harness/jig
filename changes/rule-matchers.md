---
release: minor
---

Every configuration field that chooses something by an item's or a
change's facts is now decided by one rule matcher, specified in a new
Protocol chapter.

### Added

- One rule matcher decides every configuration field that selects by an
  item's or a change's facts (`pull_requests.base_rules`,
  `pull_requests.labels_from_issue`, `pull_requests.reviewers_from_issue`,
  `do_item.gates`, `do_item.guidance`, `do_item.agents.labels`,
  `do_item.agents.codearea_areas`, `do_item.agents.title_keywords`,
  `routing.complex_flags`, `routing.raise.flags`, `routing.raise.sizes` and
  `work_batch.solo_flags`). The new Protocol chapter *Rule matchers in
  configuration* (`plugin/protocol/rule-matchers.md`) says which facts a rule may test, how each is compared, how a rule
  combines its values and how each field's rules resolve, with a data file
  and a JSON Schema for a rule. Today's forms of every field keep working
  as written. **Consumer action:** none.
- `determine_agent.ts` reads `do_item.gates` and prints, under `gates`, the
  review gates an item meets and those only its planned paths could, with
  why each applies; do-item applies what it printed.
  **Consumer action:** none.

### Changed

- **Breaking:** The shared configuration reader refuses a rule that names
  an unknown fact or gives a value of the wrong kind in any of these
  fields, naming the field and the file that set it, before any skill acts
  on it, and the audit reports it. A malformed rule a skill never read
  (such as a `do_item.gates` entry) used to be ignored; now every skill
  stops on it. **Consumer action:** required at configuration. Run the
  audit's configuration fit and fix each rule it refuses.
- **Breaking:** `work_batch.solo_flags`, and the solo-only flags work-batch
  derives, match an item's labels ignoring case, as every other label rule
  does: an issue labelled `Privacy-Review` is now held out of a batch by
  `solo_flags: [privacy-review]`, where before it was batched. The
  dispatcher's batch grouping reads the same rule.
  **Consumer action:** advised at configuration. Check that no label you
  batch differs from a solo-only flag only in case; rename it if it should
  stay batchable. **Detect:** `config:work_batch.solo_flags`.
- A route's reasons name the configuration rule that matched in the
  matcher's wording: `tier: complex (routing.complex_flags, for the item's
  label has-migration)` and `effort: high (raised from medium:
  routing.raise.flags, for the item's label has-migration)`, where they read
  `flag has-migration` before. **Consumer action:** advised at instructions.
  Update a runbook or script that reads the old reason text.
  **Detect:** `text:raised medium`.
- A malformed `do_item.gates` entry (no labels or paths, no skill, an
  unknown field, a glob that does not compile) is refused when do-item
  reads it, where before nothing read the field.
  **Consumer action:** none.
- Path globs are compiled by one shared module, so a glob in a configuration
  field and in the change-area catalog means the same.
  **Consumer action:** none.
