---
release: patch
---

### Fixed

- The dispatch dashboard now ignores closing-key examples in Markdown code,
  recognises complete comma-separated closing lists, and leaves links unknown
  when GitHub returns only part of a pull request's closing references.
- The dashboard now treats adapter names that match JavaScript inherited
  properties as unknown adapter names.
