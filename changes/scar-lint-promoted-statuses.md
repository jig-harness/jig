---
release: minor
---

### Added

- **`docs.promoted_statuses`**: the `docs` skill's scar lint scans documents whose `status` is `approved`, or any of the statuses the repository lists here (list `approved` too when both are in use), so a corpus whose lifecycle ends in another status (`active`, say) can use the lint as its gate. It is read from the configuration by the lint itself, by `/jig:docs`, and, for one run, from the `PROMOTED_STATUSES` environment variable. A repository that sets nothing scans `approved` alone, and the `OK` and `NOT SCANNED` lines read as before ([configuration](../plugin/CONFIGURATION.md#procedure-skills)).
- **Two more scar shapes**: a reviewer attribution in a table's first cell (`| Reviewer: … |`) or opening a plain paragraph (`Reviewer: …`), and a review bot's account name (`coderabbitai[bot]`, or any `…review…[bot]`). A bold tool name that heads a line (`**CodeRabbit**: …`), a reviewer named without a colon, and anything in frontmatter are not scars.

### Changed

- The lint's reports name the promoted statuses (`OK — no scars in approved or active docs`); with only `approved` they are unchanged. The scar lint's README now says why an allowlist entry matches a fragment of a path: `docs/review/` exempts the whole folder.
