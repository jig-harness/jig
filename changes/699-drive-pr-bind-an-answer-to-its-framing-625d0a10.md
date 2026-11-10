---
release: patch
---

### Fixed

- Parked decisions now carry a decision digest in their ledger and notification answer lines. Answers copied from an earlier framing leave the item parked with a stale-answer explanation; re-arms also wait when the published ledger has not caught up with local framing. Answers without a digest and legacy parks keep their time-based binding.
