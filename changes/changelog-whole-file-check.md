---
release: minor
---

### Added

- `/jig:changelog lint` (`lint.ts` in the `changelog` skill) checks the whole
  changelog against the rules of its own format and of no other, Keep a
  Changelog 1.1.0 or Common Changelog, as `changelog.format` names it or the
  file says: the title and the text above the releases, release headings and
  their order, dates written year-month-day, change types and their order
  where the format sets one, link references, and a section for every version
  the version files or the tags name. Each finding gives the file, the line,
  the rule and what to change, with the section of the format's specification
  that states the rule; what a format allows, such as a yanked release or an
  Unreleased section without a date, is never a finding. The skill's GitHub
  Action runs it as `command: lint`; the rules per format are in the
  [skill's README](../plugin/skills/changelog/README.md#checking-the-whole-changelog).

### Changed

- The Common Changelog template is now the title alone, since the format
  allows nothing but releases after it, and setup writes `changelog.format:
  common-changelog` for that format, which a file holding only its title and
  releases cannot name. A Common Changelog file whose opening paragraph names
  its format keeps working; `lint` reports the paragraph, and once it is
  removed the repository sets `changelog.format`.
