---
release: patch
---

A Linear served queue no longer spends the tracker's whole hourly request budget on one read.

### Fixed

- The batch read of issues by key and the change probe asked Linear for `{ team, number }` groups inside an `or`, and Linear answers that by matching the team's every issue. Each batch then paged through the whole team (about 200 requests for a team of 10,000 issues) and the probe never found "nothing changed", so a tick after each reset spent the dispatcher's share, and the tracker stayed walled until the next reset. Each group is now `and: [team, number]`: a lookup of up to 50 keys is one request and an unchanged queue costs one probe request.
- A batch read that pages past the pages its keys can fill now stops with an error instead of reading on, so a filter Linear stops honouring cannot walk a team again.
