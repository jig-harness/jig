---
release: patch
---

A cold read of a served Linear queue no longer costs about three requests for each issue of an epic.

### Fixed

- The issues the served walk reads by key (an epic's children, blockers, a plan's steps) now come with their relations and parent in the same paged request (`queueIssuesByKey`, 25 issues a page), where the walk read each issue's relations in two requests of its own, and what a batch carried of a parent is kept for the next tick. After a plugin upgrade or a cleared cache, the first read of a large queue costs a request per 25 issues instead of three per issue; assignment history is still read once per assigned issue, and an issue with more relations than a page holds is still read on its own. An issue the batch does not hold is read on its own.
