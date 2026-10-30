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
  link out of it, a file Git ignores, such as `.env`, and a pipe or device
  are refused before anything reads them, each file in a referenced folder
  is checked on its own and reported when refused, and no web link is
  fetched. A reader that does not answer within 30 seconds is given up on.
  Nothing else in the pickup changes. New fields, `specs.adapters` and
  `specs.body_section`, set which readers run and the spec section's heading
  ([configuration](../plugin/CONFIGURATION.md#specs)).
