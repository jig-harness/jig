---
release: patch
---

### Fixed

- Jira updates can remove a leftover real label behind an
  `issue_tracker.jira.field_labels` prefix, including one with the same
  spelling as the field's current value, without changing the field.
  Adding such a label or removing a value represented only by the field
  remains refused.
