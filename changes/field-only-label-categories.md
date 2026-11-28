---
release: minor
---

### Added

- A label taxonomy category can declare `field_only: true` for values the
  tracker keeps in a field it reads as labels but never writes, such as a
  Jira field behind `issue_tracker.jira.field_labels` that keeps no issue
  facet (Fix versions read as `fixversion:2.4`). `validate-labels.ts` no
  longer rejects those labels as unknown. It warns that each value is set on
  the tracker field after filing, lists them under `fieldOnly` in `--json`,
  and leaves them out of `labels`, so `--check-tracker` no longer fails
  looking them up among the tracker's labels. `/jig:file-issue` keeps them
  out of the labels it files and names them in its confirmation and report
  as values to set on the field. The taxonomy lint refuses a field-only
  category that is `recommended`, and any `requires` or `requires_category`
  that names a field-only category or its labels. The Jira adapter still
  refuses to write those values as labels.
