---
release: patch
---

### Fixed

- When a reviewer posts a skip notice for the current head without a review
  stamp, the drive checks the diff against `review.skip_excluded_paths`. It
  can converge when the list covers every changed path. Otherwise it stops
  with `REVIEW_SKIPPED` so a person can arrange a review.
- Sticky-summary evidence now ignores quoted and code examples, preserves
  declared and newer-round findings, and keeps skip notices from replacing a
  finding-bearing summary.
