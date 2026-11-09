---
release: patch
---

### Fixed

- Drive state writes distinguish published content whose directory durability is still pending from a failed write. Retrying inbox repair flushes the directory even when its content is already repaired.
- Fleet-health reports unreadable re-arm history even when the pull request contributes no other facts, and stops before sampling when its deadline expires during that ledger read.
- Remote verification reads each checkout's SSH transport configuration, so a drive cannot validate one checkout and fetch with another checkout's SSH command.
