---
release: patch
---

### Fixed

- Setting `review.reviewer_app: coderabbitai` selects CodeRabbit’s bot account by default for bot-thread discovery and safe chat acknowledgements. An explicit `review.bots` list overrides that bot-discovery default; reviewer evidence remains configured separately.
