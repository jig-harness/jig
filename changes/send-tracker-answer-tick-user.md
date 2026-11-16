---
release: patch
---

### Fixed

- `jig send <address> answer <key>` to a pickup's decision on a Linear or
  Jira item no longer posts an answer the dispatcher will never read. Where
  the repository names no factory identity (`dispatch.identity`), a send
  from the host that owns the repository is refused: its tick reads the
  item with the same tracker credential and never counts that user's
  comments. The refusal says to answer as another tracker user or give the
  dispatcher a tracker user of its own. A send from another host still
  posts, with a notice that the tick may not read it.
- When the only answers on such an item are by the dispatcher's own tracker
  user, the tick now reads the decision as unread and says why, and
  `jig ask pickup@…` shows that reason instead of a plain wait.
