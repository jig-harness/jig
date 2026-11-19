---
release: patch
---

### Fixed

- Drives keep their cross-clone lease during the CI watch after writing the converged label. If the final ledger write fails, recovery can publish the same exit once the drive has released its lock.
