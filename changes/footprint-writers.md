---
release: minor
---

### Added

- Pickups, scouts and issue filing record an item's predicted footprint.
  `do-item` writes the paths its change will touch after it reads the code
  and before it delegates; its scout form gains a footprint scout that
  records them without claiming the item; and `file-issue` records them when
  it files from a diff or from paths the person named, never from a
  description alone. The new `write-footprint.ts` adds the catalog areas the
  paths' files match and the base commit the prediction read, and a failed
  write never stops the work.
