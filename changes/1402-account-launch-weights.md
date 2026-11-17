---
release: minor
---

### Added

- The dispatcher reads host-local account launch weights from
  `$JIG_HOME/weights.local.yaml` every tick. Set an account's weight to 0
  to pause new launches, or use relative weights to divide launches among
  eligible accounts. Receipts and the dashboard show configured and effective
  weights; a broken accounts section closes admission with a visible reason.
