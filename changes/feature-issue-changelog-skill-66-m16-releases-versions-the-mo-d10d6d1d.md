---
release: minor
---

### Added

- [M16 Releases & versions](../modules/M16-releases-versions/README.md), a
  module for software released in versions for others to install, embed or
  consume, as [M10](../modules/M10-environments-deploy/README.md) is for a
  deployed service. Each released artifact gets one changelog, written for the
  people who use it, so changes only the maintainers notice (CI, the
  repository's own tooling, its website) stay out of it. A repository that
  releases several artifacts keeps a changelog and a version for each. The
  version is chosen once, after the merge, by one release run at a time. A
  version is tagged only on its releasing commit once that commit's checks
  pass, and the release identity gets only the access it needs. The module's
  [mappings](../modules/M16-releases-versions/mappings.md) cover Changesets,
  release-please, semantic-release, towncrier, scriv, changie, Nx Release and
  release-plz, with tools for several artifacts in one repository.
- M16's audit criteria. Every one is expected-absent for a repository
  that releases no versioned artifact. Team/Standard targets M16 Lite and
  Regulated/Strict targets M16 Standard, each only where the team says the
  repository releases versioned software.
- Glossary terms *released artifact* and *semantic versioning*.

### Changed

- `/jig:changelog` tells the agent more plainly when a change needs a note:
  only when someone who uses the released artifact would notice it. A
  refactor, a CI tweak, the repository's own scripts and instructions,
  internal design documents and a project website get none, unless the
  branch check asks for one or the repository's own written rule says
  otherwise.
- The changelog skill's branch check lets a branch correct or remove an entry
  already under Unreleased, such as a link the branch's own change broke, and
  names the lines it changes, removes or adds for the reviewer. Adding a
  line or a section there is still refused, whatever the line is: a list
  item, a paragraph, a quote or a line of code. A corrected line stays where
  it was, under the same heading and with the same indentation and marker, so
  an entry moved to another section, a continuation line turned into an entry
  or a line rewrapped onto two is refused. A heading added again, or moved to
  another depth, counts as a new section.
- M10's note on libraries now points at M16. M12 keeps the part of change
  notes that is about parallel work, and its change-note tool table moved to
  M16.
