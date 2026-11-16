---
release: minor
---

### Added

- The Jig Protocol has a provisional chapter on forge claims
  ([plugin/protocol/forge-claims.md](../plugin/protocol/forge-claims.md)):
  the takeover claim a driver posts to take a drive over from another
  clone, the launch claim a dispatching host posts for each launch of a
  drive and writes its end onto, and the announcement that a head is safe
  to merge. It gives each claim's markers, version and key, every field of
  its record with its type and which claims carry it, the actions a launch
  takes and the states its end is in, and what a reader does with a claim
  that does not read. Its data file, `plugin/protocol/data/forge-claims.json`,
  and a JSON Schema per claim (`drive-takeover-claim.json`,
  `dispatch-launch-claim.json`, `drive-merge-ready.json` under
  `plugin/protocol/schemas/`) carry them for a program that reads who
  launched a drive, how the launch ended, or whether a head was announced.
  The three readers now check a claim against the same description the
  schemas are generated from, and read every claim they read before.
  **Consumer action:** none.
