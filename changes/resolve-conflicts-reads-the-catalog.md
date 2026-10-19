---
release: minor
---

### Added

- `resolve-conflicts` reads the `generated:` entries of the change-area catalog (`drive.change_areas_catalog`): a conflicted path listed in an entry's `outputs` is mapped as a generated file and regenerated with that entry's `command`, so a generator declared in the catalog is not copied into `resolve_conflicts.generated`. A path is classified by `resolve_conflicts.generated` first, then the catalog, then the built-in lockfile table. Catalog `outputs` are literal file paths, matched exactly. A catalog entry with no `command`, one whose `outputs` are not literal file paths, and a catalog that cannot be read are reported as warnings by `conflict-map.ts` instead of being skipped; while the catalog could not be read, `check-resolution.ts` refuses until the map runs again. The snapshot's `regenerate.source` can now be `catalog`, and the snapshot records `catalogUnread`.
