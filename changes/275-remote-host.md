---
release: patch
---

### Fixed

- Drive remote checks now require a supported transport on the forge host before fetching or pushing. SSH aliases are resolved through local SSH configuration; local filesystem paths and matching repository names on another host are refused.
