---
release: minor
---

### Added

- `do-item` now says what kind of work an item is when it picks it up: its
  [work type](../GLOSSARY.md) (`bug`, `feature`, `improvement`, `task` or
  `spike`) and how it knows, in the status message, such as
  `Type: bug (label type:bug)`. The new `determine_type.ts` script derives it
  from the first of a type label, the tracker's own issue type (GitHub's
  issue types) and a Conventional Commits title prefix such as `fix:` where
  the repository's titles follow that convention; an item none of these
  identifies is `unknown`. Nothing else about the pickup changes in this
  version. See [do-item's README](../plugin/skills/do-item/README.md#the-items-work-type).
- `issue_tracker.types` names a repository's work types and the labels that
  mark each (by default `bug` from `issue_tracker.labels.bug`, and
  `<type>` or `type:<type>` for the others), and `do_item.work_types`
  overrides single fields of the depth table: how much each delivery station
  does for each type, with `unknown` always taking the strictest value of
  every field. A type outside the default list needs a complete row, and a
  label listed under two types is refused. Both fields are in the
  [configuration reference](../plugin/CONFIGURATION.md#the-depth-table), and
  the audit's configuration check refuses what `do-item` refuses and reports
  a type's labels that the label taxonomy does not define.
- `get_issue.ts` prints the tracker's own issue type as `nativeType`: the
  GitHub issue type's name, or `null` when the issue has none and always on
  Linear, which has no issue types.
