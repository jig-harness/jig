---
release: patch
---

### Fixed

- Drive review waits now pace optional forge reads against both GitHub REST core and GraphQL quotas. The limiting window appears in the outbound cost ledger, and the waits respect their existing deadlines. Each drive process also reuses its signed-in GitHub identity.
