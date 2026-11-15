---
release: patch
---

### Fixed

- `drive-pr`: after review converges, the drive's final status re-read now judges the same view as its round gate (the drive's `--bots-only`, `--no-head-sync` and inherited head), so a person's open thread under `--bots-only` no longer makes the drive re-gate every half minute for as long as it lives. A re-read that still disagrees with the gate on one commit re-gates at most `DRIVE_PR_FINAL_REGATE_LIMIT` times in a row (default 3), then stops with exit `1`, naming what the re-read saw and the command that shows it.
- `drive-pr`: a CI-hold release that fails without printing an error now leaves its cause in the driver log: which step failed, whether it was stopped at its deadline or from outside, and the command that shows its own error.
