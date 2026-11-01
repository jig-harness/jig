---
release: patch
---

### Fixed

- The docs skill's frontmatter gate no longer checks every document against a schema section it has already rejected. When the schema cannot be used as written (a section of the wrong shape, or a path rule that cannot be evaluated), the gate reports only the schema's own errors and exits 2, so `/jig:docs` shows the `frontmatter` check as `failed` instead of listing thousands of invalid-value findings that bury the real ones.
