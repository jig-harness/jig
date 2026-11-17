---
release: patch
---

### Fixed

- A dispatch tick no longer reads every waiting item of a GitHub tracker again
  when nothing about it changed. Who assigned an item is kept until the item's
  update time moves; whether that person can write is asked once per person
  and kept for 15 minutes, instead of once per item; an item's dependency
  links (blocked by, blocking), an epic's description and an issue's parent
  come with the queue read the tick already makes, instead of one issue read
  and one comment read per item at every full reading. A launch still asks the
  tracker again who made the assignment and whether they can write.
- A pull request's comments that the tick lists beyond its repository query
  are read page by page with conditional requests, each page revalidated
  against the copy an earlier tick kept: a page GitHub answers
  `304 Not Modified` costs no rate limit, and the tick report and `jig budget`
  record it as a request that cost nothing. The pages are kept in their own
  `comment-pages/` directory under `JIG_GH_CACHE_DIR` (up to 1,024 entries),
  and an entry a `304` reuses counts as used, so neither these pages nor
  `drive-pr`'s cached answers push the other out.
