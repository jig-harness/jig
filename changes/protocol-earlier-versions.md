---
release: patch
---

### Added

- The [Jig Protocol](../plugin/protocol/README.md) index says what happens to a chapter's earlier version: when a chapter's version is raised, the site withdraws the previous version's data file and schema addresses on its next deploy, without a redirect; the release notes mark the change breaking and say what a reader must change, and a reader that needs the old version keeps its own copy from the plugin release or the release's tag. No chapter has been raised past version 1. **Consumer action:** none.
