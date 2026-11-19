---
release: minor
---

### Fixed

- A drive no longer stops on a pull request whose head has many check runs. Each page of the head's check-runs listing now has its own `GH_CALL_TIMEOUT`, and the whole listing has four times that, at most 100 pages. Before, every page shared one deadline, so a long listing read as unreadable and the drive exited `1`.

### Added

- A drive end state, `CHECK_RUNS_UNREADABLE` (exit `24`), for a listing that still runs into a deadline or the page bound. Its reason, the drive's closing report and the stop recorded in the drive ledger name the pages read. `jig dispatch` re-drives it once per head commit and reports a second such stop on the same head to a person as a systematic read failure. A program that reads `drive-status.ts` or `drive.ts` exits sees the new code where it saw `1` for this failure.

### Changed

- With `JIG_FORGE_BUDGET=off`, `gh` pages the check-runs listing itself under one deadline and no page bound; the configuration reference and the drive-pr README now say so. A listing past the page bound is read once, not asked again.
