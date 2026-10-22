---
release: patch
---

### Changed

- Jig tests with Bun 1.4.4, and the `changelog` skill's GitHub Action
  installs it. Bun 1.4.4's glob matcher reads `?(…)`, `*(…)`, `+(…)`,
  `@(…)` and `!(…)` as pattern groups and expands `{1..3}` as a range, so a
  glob in a repository's own configuration that `code-stats` or `changelog`
  reads (a module's or tool's paths, the changelog's files) and that holds a
  literal `(` or `..` in those forms now matches differently: escape the
  parenthesis as `[(]` to keep matching it literally.
