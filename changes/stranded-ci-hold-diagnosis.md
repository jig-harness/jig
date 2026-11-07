---
release: patch
---

### Fixed

- Drive status and the drive doctor expose stranded CI holds, reconcile local stopped-driver evidence with running ledgers, and name the guarded direct release when its evidence is complete. Operator guidance distinguishes CI release from dispatcher release and keeps review convergence separate from full CI success.
- Hold diagnosis preserves live-process evidence and termination witnesses, scopes single-PR reads, bounds fleet diagnosis concurrency, reports Git probe failures, and includes nested forge reads in the answer's call count. Scoped diagnosis also limits recovery to the requested pull request; unavailable accounting leaves forge reads running and marks the count incomplete, and unreadable saved state preserves termination witnesses.
