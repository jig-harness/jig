---
release: patch
---

### Changed

- Issue pickup verifies claims about third-party tools against the version in
  use before delegating, and stops for re-scoping when a claim is false.
