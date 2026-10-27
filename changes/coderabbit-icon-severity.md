---
release: patch
---

### Fixed

- drive-pr and resolve-review-comments now read the severity in CodeRabbit's
  newer comment layout (`**<icon> Major** · **Category** · **Effort**`), which
  was reported as `unknown`. The new `icon-fields` shape is also available in
  `review.severity_formats`.
