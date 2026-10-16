---
release: minor
---

### Added

- `/jig:audit` scores a new Standard criterion for
  [M0](../modules/M0-instruction-architecture/README.md),
  `model-pins-are-family-aliases`: every model an agent or skill pins is a
  family alias in its metadata (or, for a judgment pass inside a skill, in
  that skill's configuration), never a versioned model id (or, where the
  runtime has no aliases, the vendor's most general model name or one
  centrally mapped name), a CI check over that metadata enforces it, and any
  committed roster of assignments is generated and drift-checked. A
  repository whose agents and skills pin no model meets it.
- The [glossary](../GLOSSARY.md) defines model tier, Judgment tier, decision
  layer, family alias, A/B baseline, cost per completed task and model roster.

### Changed

- M0's [model routing policy](../modules/M0-instruction-architecture/reference/model-routing-policy.md)
  gains a narrow Judgment tier beside Strategic, Execution and Scout, admitted one decision layer at a time by an admission test that
  runs before the cost ladder, with containment against creep, a mandatory
  A/B baseline, a one-line downgrade and a compliance rule for scheduled
  sends. Moving a pin on cost grounds needs a measured cost per completed
  task in either direction; pins are family aliases, never version strings;
  and a roster, where kept, is generated from metadata and drift-checked.
  [mappings.md](../modules/M0-instruction-architecture/mappings.md#model-tiers-per-vendor)
  gains the Judgment row, Claude Code's family-alias mechanics and dated
  observations on Judgment-tier data retention, usage credits and
  enablement.
