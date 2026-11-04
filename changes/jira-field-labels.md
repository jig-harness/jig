---
release: minor
---

### Added

- `issue_tracker.jira.field_labels`: Jira fields whose values the skills read
  as labels, each behind a prefix of the repository's choosing, so a team
  whose work carries its size, facets or owning repository in custom fields
  can route and batch on them without copying them into Jira labels. A select
  field `Size` holding `M`, with `{ Size: "size:" }`, gives the label
  `size:M`. Text, number, select, checkbox and labels fields qualify, named by
  name or by id. A pool, a population or a ledger selected by such a label is
  selected by the field in JQL; a text field's values cannot be selected
  exactly, so a query by one is refused. The adapter reads these fields and
  never writes them: filing or patching an issue with such a label is
  refused ([CONFIGURATION.md](../plugin/CONFIGURATION.md#issue_tracker)).
