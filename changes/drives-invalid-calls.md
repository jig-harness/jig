---
release: minor
---

A drive doctor with a forge client that has no login no longer repeats failing
calls on every run, and a caller whose calls all fail now shows on the
dispatcher's line.

### Added

- The dispatcher's line raises one `calls-failing` host need for a caller
  outside the tick and its passes whose calls to a system were all refused as
  `unauthorized` or `invalid` under credentials that never succeeded (at least
  20 in all), naming the caller, the classes and the number of credentials. The need clears once the
  ledger holds no such calls. To confirm after upgrading,
  `jig budget --hours 1 --json` shows no `invalid` results for
  `skill:drives.ts`, and no new unverified owner record every five minutes.

### Fixed

- `drives.ts --doctor` sent a `GET /user` and a comment read for every
  leftover driver record on every run, and all of them failed when its forge
  client had no login. The recovery now asks who the client is once for all its
  records, reads no comment when it cannot say, and leaves the records for a
  later run. A census that wants no forge access runs
  `drives-read-only.ts --doctor`, which skips the recovery.
- A forge client's refusal to run for want of a token for the account a call
  addresses is classed `unauthorized`, not `invalid`.
