---
release: patch
---

### Changed

- `decide`'s Simplified Technical English linter stays advisory on text that
  people write, with one exception: a repository may count its findings over
  documents it names, as a ratchet that refuses a change raising a
  document's count and never blocks on a single finding. The linter's
  [README](../plugin/skills/decide/scripts/ste-lint/README.md#advisory-only)
  states the rule, and its tests fail on any other wiring that runs it.
