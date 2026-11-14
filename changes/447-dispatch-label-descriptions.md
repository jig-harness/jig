---
release: patch
---

### Fixed

- `jig install dispatch --repo <path>` and `jig dispatch labels` now list
  each dispatch label the repository already has whose description is not
  the one this release gives it, beside the missing ones, and with `--yes`
  update it (`gh label edit`), so a label whose meaning a release changed no
  longer keeps an earlier release's text. A label the signed-in account may
  not edit is listed with the command a person runs. The update sets the
  description alone: a color a person chose stays, and the marker labels
  (`manual-ops`, `automation`) keep the repository's own description.
