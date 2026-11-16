---
release: patch
---

### Fixed

- Served pickups on Linear and Jira wait for delayed assignment history before standing down. A stand-down distinguishes a race from an unverifiable assignment, removes the pickup's lone assignment on timeout without conflict evidence, and asks for reconciliation when partial race history cannot establish whom to restore. **Consumer action:** none.
