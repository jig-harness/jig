---
release: minor
---

### Added

- `changelog.release.tagged_by` says who creates a release's tag:
  `workflow` (the default) or `person`. Set to `person`, the dispatcher's
  release decision recommends **Tag it by hand** and offers no re-run of
  the failed gates.
- `jig dispatch release-owed` takes `--state`, the version's state in the
  tag plan. The follow-up passes it when it records a release owed.

### Fixed

- The dispatcher's release decision recommended **Re-run the failed gates**
  even when no gate had failed. Now it recommends the re-run only while the
  releasing commit has a failed required check and a re-run is left. It
  recommends **Tag it by hand**, giving the reason, when every required
  check passed, the version is outside automatic tagging, the repository
  allows no re-run (`changelog.release.rerun_failed_gates: 0`), or the
  repository makes the tag a person's step. Releases that differ in what is
  left to try are not grouped together.
