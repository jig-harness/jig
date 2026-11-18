---
release: patch
---

### Fixed

- `jig dispatch`: one item a served person's queue could not read (an epic
  whose children did not read, an item no assigner was found for, a child
  read that failed) no longer turns off the watch on every claimed item of
  the repository. The claimed items the queue did read are still watched: a
  started pickup that stopped on a question raises its need, so it shows in
  `jig ask --waiting` and `jig send pickup@<repo>#<item> answer …` reaches
  it; a stall is reported; the idle clock runs. The same holds for a tick
  whose merge proof did not read. While the queue is read only in part, an
  ended pickup's record is released only when an item it claimed is back in
  the dispatch states, and the record of an item it never claimed is kept,
  since an item the read left out may still be wanted; the one exception is an
  ended batch that claimed some members and has no question, whose unclaimed
  siblings are released as before. A ready pool that was not read counts as
  a partial read too. Where a served queue's items in progress were not read at all (the
  queue failed, or the tracker's rate limit stopped it), the claimed items
  stay unknown and the tick says so in a row of its own, naming the person
  and what goes unchecked: stalls, double claims and the questions of
  started pickups.
