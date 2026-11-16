---
release: patch
---

### Fixed

- GitHub dispatch reads missing issues in bounded batches and reuses unchanged assigned queues between scheduled full refreshes, reducing repeated requests. An incomplete change probe refreshes the queue; failed reads retain their age and still require fresh checks before a pickup starts.
