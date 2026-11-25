---
release: patch
---

### Fixed

- `jig dispatch` no longer re-arms a drive every tick when each re-arm stops
  `NOT_SETTLED` (`4`) again on the same pull request head, as a drive whose
  required check completed skipped does after its final CI wait: the next
  re-arm on that head waits 15 minutes, doubling with each, and after 3 in a
  row the drive is a person's, notified once until its head changes.
- `jig dispatch` no longer launches a takeover every tick of a silent driver
  it started when each takeover fails (such as `drive.ts --take-over`
  refusing to take over blind) without moving the ledger: the next takeover
  waits 10 minutes, doubling with each, and after 3 in a row the drive is a
  person's, notified once until its ledger moves.
