---
release: patch
---

### Fixed

- Jira: with a facet such as size kept in a custom field, an issue whose type
  has no context for that field (an Epic, a Bug or a Sub-task, where the field
  belongs to one work issue type) could not be read at all: `get_issue.ts`
  answered `read-failed`, so do-item could not read an item's parent epic and
  did not delegate the item. Jira leaves such a field out of the issue, and
  the issue now reads as having no value in it. The error that remains, for
  an issue read without asking for the field, names the field.
