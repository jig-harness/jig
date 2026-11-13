---
release: patch
---

### Fixed

- On Jira, a type or a size kept in a custom field whose field is not on the
  create screen of the issue type being filed (a Sub-task or a Bug screen
  without the size field, say) is now refused before anything is written,
  naming the facet, the field and the issue type, instead of reaching Jira
  and failing there. A change through an edit screen that lacks the field is
  refused the same way. The check now covers number, text and labels fields
  and clearing a value, not only an option's value.
- The audit's facet-store check on Jira reads the create screens of
  `issue_tracker.jira.issue_type`, the sub-task type, each issue type a type
  is kept as and `issue_tracker.jira.pool_issue_types`, and reports each one
  that lacks a facet's field, naming the issue types whose filing fails.
