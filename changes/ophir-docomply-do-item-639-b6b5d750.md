---
release: minor
---

### Added

- An owner-host steward inspects stopped work and the assigned queue when
  its input changes, at most three times an hour. It proposes bounded
  recoveries, one fixed resume for a routine question, missing issue facets,
  queue tie order and clearer human needs; the next dispatcher tick applies
  its records under existing holds, account admission and recovery budgets.
  Enable it in the machine dispatch file with `steward.enabled: true` and
  the repository's `steward` stage.
