---
release: patch
---

### Fixed

- Served pickups on Linear and Jira wait for delayed assignment history before standing down. A stand-down distinguishes a race from an unverifiable assignment, removes the pickup's lone assignment on timeout without conflict evidence, and asks for reconciliation when partial race history cannot establish whom to restore. **Consumer action:** none.
- Assignment verification now preserves a complete tracker history's ordering for tied timestamps and rechecks ownership inside cleanup operations, so delayed history and concurrent ownership changes cannot cause an incorrect cleanup. **Consumer action:** none.
