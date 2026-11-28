---
release: patch
---

### Fixed

- Setting `review.reviewer_app: coderabbitai` also selects CodeRabbit’s bot account by default, so the drive can recognize its chat acknowledgements and resolve them with the held reply. An explicit `review.bots` list overrides the default.
