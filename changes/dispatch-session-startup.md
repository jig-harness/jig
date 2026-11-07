---
release: patch
---

### Fixed

- The dispatcher backs off a Claude account when a headless follow-up exits
  before starting a session, and releases that attempt's marker so another
  admitted account can retry automatically. Its outcome distinguishes a
  recognized quota notice from an unknown startup failure; a session with a
  transcript still counts as a pass that died.
