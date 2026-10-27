---
release: minor
---

### Added

- `do-item` shows, after it fetches an item, the requirements, acceptance
  criteria and tasks the item carries: its `## Spec`, `## Requirements` and
  `## Acceptance criteria` sections, with the ids the text gives them
  (`FR-001`, `AC-1`, a numbered checkbox) or, for an item with none, an id
  derived from its text, and each reference it did not read with the reason.
  The resolver behind it (`plugin/shared/spec/resolve.ts`) reads only inside
  the repository: an absolute path, a `..` that leaves the root, a symbolic
  link out of it and a file Git ignores, such as `.env`, are refused before
  anything reads them, and no web link is fetched. Nothing else in the pickup
  changes. Two new fields, `specs.adapters` and `specs.body_section`, set
  which readers run and the spec section's heading
  ([configuration](../plugin/CONFIGURATION.md#specs)).
