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
  from the tick. A batch that names an issue the credential cannot see is
  read one issue at a time; a batch refused for the rate limit or left
  without an answer fails the check with that failure, as a single read did.
