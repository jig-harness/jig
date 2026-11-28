---
release: patch
---

### Fixed

- Setting `review.reviewer_app: coderabbitai` selects CodeRabbit’s bot account by default for reviewer evidence and bot-thread discovery. Chat acknowledgements remain non-transparent until an explicit `review.bots` list grants that authority; an explicit list otherwise overrides the default.
