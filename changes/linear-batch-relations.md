---
release: patch
---

A cold read of a served Linear queue no longer costs about three requests for each issue of an epic.

### Fixed

- The issues the served walk reads by key (an epic's children, blockers, a plan's steps) now come with their relations and parent in the same paged request (`queueIssuesByKey`, 25 issues a page), where the walk read each issue's relations in two requests of its own. After a plugin upgrade or a cleared cache, the first read of a queue of a thousand issues is a few dozen requests, not a few thousand, so it fits the dispatcher's share of the hourly budget. An issue the batch does not hold is read on its own.
