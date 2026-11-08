---
release: minor
---

Jira and Linear repositories can keep an issue's type and size in their trackers' own fields: Jira's issue types and custom fields, and Linear's estimate. A repository that names no store files and reads exactly as before.

### Added

- Jira's issue types as the type's store (`issue_tracker.facets.type: { store: native }`, with `values` where names differ, such as `feature: Story`): a new issue is filed as the standard issue type of its type's name. A type with no such issue type, an issue created under an Epic, and a sub-task keep the type in its label beside `issue_tracker.jira.issue_type` or the sub-task type; a type label wins over that fallback issue type, and any other two different values read as no type, which the weekly sweep reports. A change of type changes the issue type in the same write and takes the type's labels off ([CONFIGURATION.md](../plugin/CONFIGURATION.md#issue_tracker)).
- A Jira custom field as the store of a type or a size (`{ store: field, field: Size }`, by its name or its id, `customfield_10016`): read in the request that reads the issue, written in the one that files or changes it, a select field's option checked against the create or edit screen's options before anything is written. A name several fields of the site share is refused, naming each one's id.
- Linear's estimate as the size's store (`issue_tracker.facets.size: { store: native }`): the sizes map in order onto the team's estimate scale, or onto the points `values` names; a team with estimates off, or a scale with fewer points than the sizes, is refused before anything is written. `tracker.ts facet-stores` reports each of these stores' health.

### Changed

- On Jira, an `issue_tracker.jira.field_labels` entry whose labels are a facet's values (a `Size` field behind `size:` where the label taxonomy's sizes are `size:S`, `size:M`, `size:L`) is now that facet's field store: filing or changing the size writes the field, where the previous release refused it, and its values still show as labels. A label behind such a prefix among the labels of a filing is refused, pointing at the facet.
- `check-fields.ts move` refuses to move Jira's type from its labels into the issue types, since the issue types keep a sub-task's type, and a type with no issue type of its own, in those labels; naming the store needs no move, since a type label wins over the fallback issue type.
