---
release: patch
---

### Fixed

- The dispatcher reports a refused steward record only on the tick that refuses it and skips stored digest reads for settled records. Continuing needs keep their steward framing, and retained records still witness the decision.
