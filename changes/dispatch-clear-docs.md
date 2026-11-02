---
release: patch
---

### Changed

- The dispatcher's README says which launch records `jig dispatch clear`
  clears and which it refuses, as the command does: it clears an unknown
  record, a pending one whose launch cannot be retried, or one that does
  not read (whatever state its claim shows), and refuses a running record
  and, among the records that read, an ended or died one and a pending
  one that can still be retried.
