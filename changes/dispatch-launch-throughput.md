---
release: minor
---

### Added

- The dispatcher's machine file accepts `opens_per_tick` (default `4`) to
  fill more free account slots in one tick while keeping an open for notices.
  Its deadline covers the configured workspace opens and refuses limits
  beyond the timer's range.

### Fixed

- Drive launches and pickup/follow-up launches take turns leading across
  repositories, so a backlog of old merges cannot keep new drives waiting
  behind follow-ups for more than one tick when capacity is available.
  Waiting launches say whether the accounts or the per-tick open budget
  holds them, in both the receipt and the dashboard's queue.
- Notifications wait for a later tick when their complete workspace read
  or delivery cannot finish while preserving time to write the tick's receipt.
