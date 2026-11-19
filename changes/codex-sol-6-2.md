---
release: patch
---

### Changed

- The Codex `sol` alias (the strategic tier) now names `gpt-6.2-sol` instead of `gpt-6.1-sol`. Routing, the drive-pr pass model and the dispatcher pick it up without configuration; a configuration that pins `gpt-6.1-sol` by its full name keeps that model.
