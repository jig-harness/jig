---
release: patch
---

### Fixed

- A dispatch tick whose time bound ends its forge read now records that
  the open pull requests were not listed, as every other failed forge
  read does. **Consumer action:** none.
