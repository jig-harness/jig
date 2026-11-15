---
release: minor
---

### Added

- The Jig Protocol has a provisional chapter on tracker facets
  ([plugin/protocol/tracker-facets.md](../plugin/protocol/tracker-facets.md)):
  the three facts every issue carries beside its labels (type, priority and
  size), the number of each priority, the stores a facet may be kept in,
  which stores each tracker adapter holds for each facet and why it refuses
  the others, and the reasons `tracker.ts facet-stores` gives for the store
  in force. Its values are generated from the tables the tracker reads its
  configuration with, and its data file,
  `plugin/protocol/data/tracker-facets.json`, carries them for a program
  that reads an issue's facets or a repository's stores.
