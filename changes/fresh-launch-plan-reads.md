---
release: patch
---

### Fixed

- `jig dispatch` read every issue an epic's execution plan names one request
  at a time when it re-checked a pickup just before launching it, and again
  when the claim checked it: about 40 requests for each pickup under a long
  plan, repeated for every pickup that waited on the workspace budget. That
  check now reads the plan's issues, and each parent's own row, together:
  on GitHub one `TrackerDispatchIssues` request for up to 20 issues, on
  Linear the batched pool read. It still reads them fresh, with nothing kept
  from the tick, and a batch the tracker cannot answer is read one issue at
  a time as before.
