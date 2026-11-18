---
release: patch
---

### Fixed

- `jig ask` reports the local driver lock even if the CI-hold diagnosis times out. `jig send rearm` checks that lock without running the diagnosis and surfaces an unreadable lock as a dispatcher need. **Consumer action:** none.
