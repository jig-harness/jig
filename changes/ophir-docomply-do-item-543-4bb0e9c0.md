---
release: minor
---

### Changed

- **Breaking:** The dispatcher now treats a drive that stopped with no recorded exit as an accident and re-arms it within a budget of 3 attempts per pull request in a rolling hour. To keep a drive stopped, use `drives.ts --stop`, a mailbox stop or pause, or the hold label; a recorded no-exit stop no longer keeps it stopped. Hard termination of both the driver and its launch wrapper can leave a running ledger outside this recovery path. Legacy no-exit ledgers receive at most one automatic attempt. Repeated no-cause stops notify a person once with the drive's handoff.

### Fixed

- Deliberate stops publish and verify the person's intent and optional reason before signalling, so a failed final ledger write cannot let another host re-arm them. Stop-bearing ledgers use format version 2; older Jig copies refuse them and must be updated before driving those pull requests.
- With ledger mirroring enabled, a stop refuses to signal a driver whose published ownership cannot yet be verified. Hold dispatch and retry after startup publishes its ledger; the driver now publishes that ownership immediately after initialization.
