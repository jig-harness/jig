---
release: patch
---

### Fixed

- The `jig dispatch dashboard` tab shows Jig's mark as its icon, in the
  colours of the reader's light or dark theme, instead of a blank one. The
  page holds the icon itself, so the browser still never asks the server
  for a file without the page's token.
