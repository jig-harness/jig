---
release: patch
---

### Fixed

- `jig dispatch`: after a person answers **Release the claim** on a stalled
  pickup, the dispatcher releases it at the tick and the next launch is an
  ordinary fresh pickup. That launch is no longer handed the answer as an
  option to carry out, which could make it only re-confirm the release, end
  without claiming the item and raise the same card again.
- The ended-pickup card now says what holds the item: the named launch
  record ended and has not been released. It says the item is still assigned
  only when it is.
- A release answer an earlier version already kept for the next session is
  passed over, so that launch is an ordinary fresh pickup too.
