---
release: patch
---

### Fixed

- Bound the test fixture registry when a registration is written and retire
  proven-dead registrations in bounded pages. A scheduled collector that can
  only report an over-limit store now fails with a receipt that gives the
  reason.
- Report fixture registry usage and free inodes in `jig doctor gc` and
  surface storage pressure as a host need in the dispatch dashboard.
