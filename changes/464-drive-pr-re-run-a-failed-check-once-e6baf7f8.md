---
release: patch
---

### Fixed

- A drive retries failed workflow jobs once before spending a CI-repair pass. Repair allowances now belong to each head and failing check, so an earlier failure cannot exhaust another check's budget. Set `ci.rerun_failed_once: false` to disable the retry independently of repairs. Infrastructure failures keep their existing recovery path. **Consumer action:** none.
