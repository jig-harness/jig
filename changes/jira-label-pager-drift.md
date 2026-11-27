---
release: patch
---

### Fixed

- On Jira, listing the site's labels (`tracker.ts available-labels`, and
  `validate-labels.ts --check-tracker` under `/jig:file-issue`) no longer
  fails with `labels: <name> repeated across pages` when someone adds a label
  on the site during the read. Jira pages its labels by offset without a
  snapshot, so a new label shifts the next page by one; the repeated name is
  now kept once. Labels are read 1,000 to a page, Jira's own default, instead
  of 100, so a large site takes a few requests where it took many. Every
  other Jira listing still fails a read that repeats an item.
  **Consumer action:** none.
- `validate-labels.ts --check-tracker` reports a label set the taxonomy
  refuses with exit 3 and its taxonomy errors, without reading the tracker's
  labels first, so a failed label read (exit 1) no longer hides the real
  verdict. A draft whose only gap is a facet its Jira screen does not offer
  is still exempted before that verdict. **Consumer action:** none.
