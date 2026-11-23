---
release: patch
---

### Fixed

- Re-arming a drive that stopped on its round budget (`MAX_ROUNDS`) now
  runs review passes again instead of stopping with exit `6` on its first
  check. A re-arm a person asks for (`jig send drive@<repo> <PR> rearm`) and
  `arm-drive.ts --rearm-budget` grant the drive one more round budget:
  `drive.max_rounds` (or `--max-rounds`) more distinct heads, counting the
  head it resumes on, and a fresh count of passes on that head. The steward's
  and the tick's re-drives never grant it. The grant is kept in the drive
  state and published to the ledger so a restart or a takeover keeps it, and
  is never renewed without another re-arm: the drive stops on `MAX_ROUNDS` again
  once it spends it. `jig send … rearm` on such a stop says so.
