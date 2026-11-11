---
release: patch
---

### Fixed

- Fleet health counts re-arms from the pull request's drive ledger as ceremony, with the configurable `ceremony.weights.drive_rearms` weight (default `1`). Handoffs remain unmeasured because their narratives carry no dated history.
