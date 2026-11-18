---
release: patch
---

### Fixed

- A dispatched pickup or steward pass whose Claude Code session stops at
  startup on a usage-limit notice now walls its account, as a follow-up's
  already did; before, the pickup was logged as died, the account stayed
  admitted, and the item waited for a person to release it. The wall lifts
  at the reset the notice states, in both its time-of-day form
  (`resets 3:20am (Europe/Amsterdam)`) and its dated weekly form
  (`resets Nov 13, 11am (Europe/Amsterdam)`), and `dispatch.wall_backoff`
  applies only when that reset cannot be read. A pickup stopped this way is
  picked up again on another account, or on its own once the wall lifts,
  with no person asked. **Consumer action:** none.
