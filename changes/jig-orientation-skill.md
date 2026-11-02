---
release: minor
---

### Added

- `/jig:jig` says which of the plugin's skills fits a task and what comes
  after it, where a setting or a practice is documented (the reference
  installed with the plugin, and Jig's repository at the installed
  version's tag), and what to do when Jig itself is wrong. For a Jig bug
  it checks that the fault is Jig's (`jig doctor` rules out a setup
  fault), searches for an existing issue, and drafts the report in the
  fields of Jig's bug form with `skills/jig/scripts/report-bug.ts`, which
  reads the version and the operating system itself and replaces the
  repository's own names with placeholders; a person confirms before it is filed on jig-harness/jig.
