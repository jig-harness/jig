---
release: minor
---

### Added

- A served person's epic children now start on Linear and Jira too. An
  inherited claim (`claim --for <person> --ancestor <epic>`) assigns the
  unassigned child, then checks the item's history to confirm the
  assignment replaced nobody. If it did replace someone, it puts them back
  and stands down. Neither tracker offers a write that applies only to an
  unassigned item, so before this the claim refused there.

### Changed

- `do_item.claim_marker` now serializes claims across hosts. The claim
  posts its marker before it writes the item's assignee or state, then
  reads the item's markers back. Of the markers posted within 10 minutes of
  its own, the earliest wins. A claim that finds an earlier marker, or that
  cannot post or read back its own, removes its marker and refuses (exit 3,
  `"why": "marker"`), with nothing written to the item. A claim that finds
  an earlier marker only after writing stands down (exit 4). Turn the
  setting on wherever more than one host picks up from one queue; left
  unset, claims serialize on one host only.
- With `do_item.claim_marker` set, a marker that cannot be posted now
  refuses the claim, where it used to leave the claim standing. The claim's
  `"marker"` JSON now reports `confirmed`: whether the read after the write
  confirmed that the claim still holds the earliest marker.
