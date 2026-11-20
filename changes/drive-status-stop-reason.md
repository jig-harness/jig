---
release: patch
---

### Fixed

- When a drive stops on an exit from its status probe, the driver log, handoff and drive ledger keep the probe's state and reason. Dispatch and `jig ask` can show what happened, and an indeterminate probe that reports a read failure or rate limit is classified accordingly.
- Fresh status evaluations clear an earlier failure classification, and an unreadable draft-skip comment is reported as a read failure. **Consumer action:** none.
