---
release: patch
---

### Fixed

- Waiting drives list pull request comments for takeover checks once a
  minute after a complete round-boundary read, reducing GitHub quota use.
  An unread listing is retried at the next checkpoint. Claim checks before
  dispatching a pass and writing the ledger still read fresh.
