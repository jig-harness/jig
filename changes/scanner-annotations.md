---
release: minor
---

### Added

- `resolve-review-comments` and `drive-pr` now see the findings a static-analysis app reports as check-run annotations rather than review threads, as SonarQube Cloud's pull request decoration does. `list-scanner-annotations.ts` lists the warnings and failures on the head commit, and the round triages each as a finding. The apps read are `review.scanner_apps`, default `sonarqubecloud`. Annotations with the same text in one file, from any of the app's runs, are one finding that lists every place it is reported, and its fingerprint stays the same when an edit moves or removes one of those places, so a deferred finding keeps one backlog entry.
