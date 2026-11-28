---
release: patch
---

### Fixed

- Setting `review.reviewer_app: coderabbitai` selects CodeRabbit’s bot account by default for reviewer evidence, bot-thread discovery, and safe chat acknowledgements. An explicit `review.bots` list otherwise overrides the default.
