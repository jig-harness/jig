---
release: minor
---

### Added

- `design-brief-builder` owns returned design bundles: it stages a three-way merge against the recorded raw export, reports lost repository fixes, and checks every scenario before landing. Configure `design_brief.handback` with viewport widths, a Chrome or Chromium executable, rubric and scorecard paths, and any forbidden terms; each bundle supplies its scenario manifest, with a ready selector per scenario, and the scorecard names the export base it reviewed. Brief data-facts tables are generated from source commands with their command and timestamp recorded.
