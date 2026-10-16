---
release: minor
---

Jig now teaches keeping the areas that no gate covers under a known audit cadence.

### Added

- An audit catalog template in [M8](../modules/M8-learning-loop/README.md#the-audit-catalog-areas-no-gate-covers): one row per drift-prone area with its owner, cadence, tooling, last-audited date and open work, where an area audited only by hand is tracked as a gap in tooling. [M4](../modules/M4-docs-governance/README.md) links to it from its wiki-lint cadence, and the module's mappings say where the reminder for each cadence lives.
- An optional deep-review tracker template that versions the dimensions of a deep review and queues a re-review of every area last reviewed under an older version.
- The audit scores one new criterion, `M8/audit-catalog-maintained` (Standard), which a repository without such a catalog scores as absent, unless a gate fully covers every one of its areas (then the criterion is expected to be absent and counts as met); Jig's own record and the example audit carry it. The glossary defines audit catalog, drift-prone area and deep-review tracker.
