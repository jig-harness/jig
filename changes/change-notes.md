---
release: minor
---

Pull requests stop conflicting over the changelog and the version: each adds
a change note, and the release is written after the merge.

### Added

- Change notes, [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s
  new core piece: a pull request records its changelog entry and the release
  it needs in a file of its own instead of editing the changelog and the
  version that every pull request edits, so merging one no longer puts the
  others in conflict. The portable form is
  [reference/change-notes/](../modules/M12-parallel-agent-ergonomics/reference/change-notes/README.md):
  `release.ts` writes the notes into a Keep a Changelog file after the merge
  (Unreleased for a note that asks for no release, the next version's
  section otherwise), moves the version files to the largest bump asked for,
  moves the comparison links and fills in a placeholder for the version,
  with `--per-merge` one merge at a time; `check.ts` fails a note it could not read, a branch that edits what the
  release step writes, and a change to a released path without a note that
  asks for a release. M12's mappings compare Changesets, towncrier, scriv and
  changie, and say why a union merge driver or a changelog generated from
  commits is not the same.
- `/jig:audit` scores two new M12 criteria:
  `M12/change-records-one-file-per-change` (Lite) and
  `M12/change-records-assembled-after-merge` (Standard). Jig's record scores
  both absent at its audited commit, which predates them.
- [ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md):
  a pull request adds a change note, and the release is written after the
  merge. ADR-0002 is amended to match.

### Changed

- Jig's own pull requests add a change note under
  [changes/](README.md) instead of editing CHANGELOG.md or the plugin
  manifests. After every merge, `.github/workflows/release.yml` runs
  `scripts/release.ts` on main, one run at a time and one merge at a time: it
  writes the notes into CHANGELOG.md, and when a note asks for a release it
  moves both manifests, commits and tags `v<version>`, so each merge that
  changes `plugin/` is still a version of its own. The workflow pushes as the
  `jig-release` GitHub App, the one actor main's ruleset lets push past the
  pull-request and check rules, with a token minted per run from a key only
  main's `release` environment holds. `bun run gates` holds branches to it
  (`scripts/check-changelog.ts`).
- A criterion's or a configuration field's `since:` may be `next` until its
  release: the audit reads it as newer than any released version, and Jig's
  release step replaces it with the version it releases.
- `/followup` checks that the release workflow wrote the merge's notes before
  it checks the tags, and `/website-update` records a site change as a change
  note.
- `main`'s rules (a pull request with `gates` green and its threads
  resolved, no force push, no deletion) move from branch protection to a
  repository ruleset, the only form that can let the release App past them;
  repository administrators keep their bypass. `scripts/check-branch-protection.ts`
  reads a ruleset as well as branch protection and lists its bypass actors
  ([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md) is amended to match).
