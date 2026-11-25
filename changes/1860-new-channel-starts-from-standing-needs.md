---
release: patch
---

### Fixed

- A notification channel added to a dispatch host no longer sends every need that
  already stands, one message each. On the first tick it can send, the channel
  records the standing needs of each repository as known without sending them,
  and sends only needs that appear or change afterwards; the tick's
  receipt says once how many it started from. The recorded needs are repeated on
  `dispatch.renotify_after` while they stand, as before. A renamed channel, or
  one whose records were dropped, starts again the same way. The start is per repository: a repository reached on a
  later tick starts silently too, and one with a send record of the channel is not started
  again. The Orca card and a channel that already has records are unchanged. See
  [`notify.channels`](../plugin/CONFIGURATION.md#the-machines-dispatch-file).
