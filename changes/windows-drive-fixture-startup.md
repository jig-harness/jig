---
release: patch
---

### Fixed

- Reduce process startup in the drive-pr test fixtures while preserving the
  fixture queries and responses used to check the driver on Windows.
- Keep exact state-directory identities in the triage fixture so Windows
  inode values cannot lose precision before the posting fence checks them.
- Name the remaining Windows fixture throughput limits for multi-round,
  long-CI drive and large post-retirement census tests; their
  existing deadlines remain in place while native optimization is pending.
