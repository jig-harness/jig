---
release: patch
---

### Changed

- A template or a gate that a skill uses now lives in that skill, not in the
  module it came from: the module contract no longer requires `templates/` and
  `reference/` in every module, and the licence gate lists templates under
  `plugin/skills/*/templates/` in `NOTICE` like those under `modules/`. Nothing
  moves yet; the `kickoff` and `docs` skills bring their assets in when they
  arrive.
