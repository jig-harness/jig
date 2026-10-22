---
release: minor
---

GitHub Issues is a supported issue tracker beside Linear: picking up, filing,
planning and reporting work on the issues of a repository, and keeping
session reflections there.

### Added

- A GitHub Issues tracker adapter: set `issue_tracker.adapter: github`, and
  `do-item`, `file-issue`, `work-batch`, `reflect`'s escalation and the
  fleet metrics work on the issues of the repository the `origin` remote
  points to (or `issue_tracker.github.repository`), through the signed-in
  `gh` command line. Issue keys are `#123`; a bare number or the issue's web
  address is read as the same key. An open issue's workflow state is a label
  per state, or with `issue_tracker.github.states_from: project` the option
  of a Projects board's Status field; a closed one is the reason it was
  closed. Priority is a label per level, a project is a milestone, children
  are sub-issues, and `blocks` and `duplicate` use GitHub's own dependency
  and duplicate links
  ([configuration](../plugin/CONFIGURATION.md#issue_tracker),
  [how it maps](../plugin/EXTENDING.md#issue-tracker)).
- A `github` reflection store: with `reflection.store: github` and
  `reflection.github.repository: owner/name`, session reflections are kept
  as issues of that repository, one per change, each finding a record in a
  comment; only comments by people who can write to the repository count
  ([the GitHub store](../plugin/skills/reflect/README.md#github-store)).
- An [issue key](../GLOSSARY.md) now has the shape its tracker gives it
  wherever the skills read or write one: in branch names (`123-fix-login`
  under the default `{key_lower}-{slug}`), commit and pull-request trailers
  (`Closes #123`), file names (`issue-123`), decision and explainer sheets,
  and the fleet metrics. The skills' procedures quote every key on a command
  line, since an unquoted `#` starts a shell comment.

### Changed

- The issue a branch names is read under the configured
  `pull_requests.branch_name` pattern, with one leading `<word>/` segment
  allowed before a team key, by both the drive's intent-chain handoff and
  `reflect`, including a pattern that puts the key after the slug
  (`{slug}-{key}`); the handoff previously recognised only
  `feature/<KEY>-…` branches, and `reflect` a team key anywhere in the name.
