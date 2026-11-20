---
release: patch
---

### Fixed

- A pickup the host would hold no longer spends tracker reads. Before it reads the item from the tracker again, the dispatcher now checks whether any account has a free slot for it and, under `load.enforce`, whether the host's load holds it. A pickup that either check holds sends no request. A line held for many ticks no longer uses up the dispatcher's share of a Linear credential's request window. A pickup that passes both checks still reads the item, its relations and its assignment just before it starts. The Linear adapter now looks up the served person's user once for each repository's tracker in a tick, instead of once per candidate. **Consumer action:** none.
