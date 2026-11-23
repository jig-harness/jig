---
release: patch
---

### Fixed

- **Dispatch:** a batch pickup that ended on a question no longer holds every
  member the question does not name. The members it never claimed and the
  question does not name are picked up again by the queue's usual rules, with
  no need raised for them, whether or not the pass claimed any member; hosts
  holding members this way release them on the first tick after the upgrade.
  A question that names no member is one need on the batch's anchor, the other
  members wait on it with no need of their own, and answering it releases
  every member the pass never claimed.
