---
release: minor
---

### Added

- `/jig:red-team` reviews a requirements document (a PRD) or an architecture
  document adversarially, by persona: a critical chief technology officer, a
  security auditor, a performance engineer and a cost optimizer read both
  kinds, and a requirements document is also read by a reader who knows no
  engineering terms, a scope cutter, an acceptance tester and a
  day-in-the-life walker. Each persona reads in fresh context (a subagent,
  else a fresh run of the agent command, else this session, which the report
  then says), and one report gives each persona's verdict and every finding
  with the quoted passage, the risk and the question the author must answer.
  It never edits the document, and the report ends with the line the
  accepted document's stage-review record cites it with. It is the runnable form of
  [M6](../modules/M6-feature-delivery-pipeline/README.md)'s per-stage
  adversarial review for the requirements and architecture stages, and the
  [greenfield guide](../adoption/greenfield.md)'s critical-analysis phase
  points at it ([the skill](../plugin/skills/red-team/README.md)).
