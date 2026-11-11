---
release: minor
---

### Added

- `pull_requests.title_format: pattern` with `pull_requests.title_pattern`
  states a pull-request title that leads with the tracker key, for
  repositories whose protected branches refuse a commit without one. The
  pattern has the placeholders `{key}` and `{summary}`, each once, such as
  `{key}: {summary}`. `pr-plan.ts open --issue ENG-12` prints the title as
  `ENG-12: <summary>`, and the audit warns when fewer than 80% of the
  integration branch's last 30 commit subjects follow the pattern. Leaving
  `title_format` unset keeps today's derived convention.
