---
release: patch
---

### Fixed

- Merge-readiness facts preserve a final fractional-second budget, reject malformed first check pages, and retain continuation-query diagnostics. **Consumer action:** none.
- Merge-readiness facts keep a pull request out of the Ready lane when a null check rollup is not tied to its current head commit. **Consumer action:** none.
