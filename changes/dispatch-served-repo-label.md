---
release: patch
---

### Fixed

- Dispatch no longer starts a served person's item in the wrong repository's
  checkout. Where several repositories share a tracker team, each one's tick
  read every item assigned to a served person, so an item labelled for one
  repository could be launched from another's. An item that carries another
  repository's label (a `review.taxonomy.repos` entry other than the
  checkout's `review.repo_label`) is now left to that repository, both when
  the queue is read and again at launch; an item with no repository label, or
  one that also carries this repository's, is unchanged. A checkout that sets
  no `review.repo_label` keeps today's behaviour.
