---
release: patch
---

### Fixed

- The `jig:followup-failed` pull request label has its own crimson
  (`a40e4c`) instead of `jig:parked`'s red, so a pull request whose
  follow-up failed is told apart from one waiting on a person's answer.
  Green stays `jig:converged`'s alone, and a test holds the label set to
  that rule.
- `jig dispatch labels` (and the labels part of `jig install dispatch`)
  now also lists a dispatch label whose color differs from this release's
  and, with `--yes`, sets it. A label the signed-in account cannot edit is
  printed with the `gh label edit … --color` command a person runs. Run
  `jig dispatch labels --yes` once in each repository that installed the
  labels earlier to bring its colors up to date.
