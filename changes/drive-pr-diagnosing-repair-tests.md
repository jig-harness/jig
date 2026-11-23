---
release: patch
---

### Fixed

- The drive-pr suite's diagnosing CI repair tests no longer time out under a
  loaded CI shard: the receipt rules (a tracker issue key or a filing parked
  during the diagnosis) are unit tests against the driver's receipt reader,
  and the end-to-end drives that remain have the 120-second headroom of the suite's
  other multi-round drives. A drive behaves as before. **Consumer action:**
  none.
