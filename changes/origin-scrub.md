---
release: patch
---

### Changed

- The plugin's code comments and tests state each rule directly instead of
  pointing at an unnamed earlier change, and the tests no longer carry the
  placeholder issue keys a mechanical scrub left behind. No behaviour
  changes.
- The origin-reference gate (`scripts/check-no-tracker-refs.ts`) reads the
  organization's name and tracker team key from the repository's own
  `.config/jig.yaml` (`review.repo_slug` and `issue_tracker.team`), so its
  pattern file spells out neither. A pattern that names a value the
  configuration does not supply makes the gate fail rather than pass. The
  gate also catches a tracker key folded into a name (`eng1234-main`,
  `PRE_ENG_1234_ACCOUNT` for a team `ENG`).
