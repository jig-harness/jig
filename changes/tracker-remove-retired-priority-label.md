---
release: patch
---

### Fixed

- On GitHub Issues, where priority is kept in a field rather than in labels,
  `tracker.ts update` now removes a leftover `priority:` label named in
  `removeLabels` instead of refusing it. Adding one is still refused, and the
  message names the field priority is kept in. Where priority is kept in
  labels, both stay refused, so priority still changes only through
  `priority`. **Consumer action:** none.
