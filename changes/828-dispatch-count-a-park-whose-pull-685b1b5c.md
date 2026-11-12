---
release: patch
---

### Fixed

- The dispatcher's park counts include final resolution receipts when a pull request that held parks merges or closes between ticks. Missing receipts remain uncounted, and failed final reads retry on a later tick.
