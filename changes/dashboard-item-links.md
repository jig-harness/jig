---
release: patch
---

### Fixed

- The dispatch dashboard now shows each tracker item's title beside its key
  and links the key, on every card (Needs you, Running, Queue) and every
  History row. The dispatcher keeps the link and title the tracker listing
  returned on items the walk could not place, on claimed items, and on the
  outcome log's rows. For a record that kept no link, such as a row written
  by an earlier version, the page works the link out from another item link
  of the same repository's tracker, and only when it cannot does it say so,
  naming what is missing and where to look, in place of the old text about
  a tracker base no setting provides.
- A tick that finds a repository held by another tick no longer freezes the
  dashboard's line. Each repository's part of the line (its needs, queue,
  sessions and Ready cards) now comes from the newest tick that read it, and
  each tick the timer runs updates the rest, so the page no longer reports
  that the timer has not ticked while it runs. A repository no tick has read
  for longer than the timer's interval gets a banner naming it, when it was
  last read and why (another tick held it busy).
