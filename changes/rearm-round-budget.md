---
release: patch
---

### Fixed

- Re-arming a drive that stopped on its round budget (`MAX_ROUNDS`) now
  runs review passes again instead of stopping with exit `6` on its first
  check. A re-arm a person asks for (`jig send drive@<repo> <PR> rearm`), a
  steward's re-arm and `arm-drive.ts --rearm-budget` grant the drive one
  more round budget: as many rounds past those it spent as its
  `drive.max_rounds` (or `--max-rounds`). The grant covers both durable
  counters, the distinct heads reviewed and the passes on one head, is kept
  in the drive state and ledger so a later restart keeps it, and is never
  renewed without another re-arm: the drive stops on `MAX_ROUNDS` again
  once it spends it. `jig send … rearm` on such a stop says so.
