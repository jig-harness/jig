# Changelog

Notable changes to Groundwork. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A version number is the version of the `groundwork` [plugin](plugin/README.md)
(`version` in `plugin/.claude-plugin/plugin.json` and
`plugin/.codex-plugin/plugin.json`), and each release is tagged `v<version>` on
its merge commit. Machines receive a change to the plugin only through a new
version, so every pull request that changes `plugin/` adds its entry under that
new version's heading. Changes outside the plugin (modules, the auditor,
documentation) collect under **Unreleased** until the next plugin release
carries them. `bun run gates` fails when the current plugin version has no
heading here.

Before 1.0.0, a minor version can change behaviour that consumers rely on; such
changes are marked **Breaking** and say what a consumer changes.

## [Unreleased]

## [0.11.0] - 2026-10-12

### Added

- `resolve-conflicts` skill: resolves the conflicts a merge, rebase or
  cherry-pick stopped on. `conflict-map.ts` names each side by its role (the
  branch or the upstream, so a rebase's reversed "ours" and "theirs" cannot
  mislead), classifies every conflicted path (text, lockfile, generated,
  binary) and lists the commits on each side that changed it.
  `check-resolution.ts` refuses a resolution that leaves conflict markers or
  unmerged paths, lacks a recorded decision, or drops lines either side added
  without saying why, and prints the decisions for the merge commit message.
  Configuration: `resolve_conflicts.generated`.
- `drive-pr` hands a conflicting pull request to `resolve-conflicts` in its
  conflict-repair round.
- [Recommended third-party skills](plugin/RECOMMENDED-SKILLS.md) that work well
  with Groundwork, and credits for the outside work Groundwork's own skills
  build on.
- This changelog, and a gate that requires an entry for the current plugin
  version.
- Nested agent instructions: [plugin/AGENTS.md](plugin/AGENTS.md) and
  [modules/AGENTS.md](modules/AGENTS.md).
- [CONFIGURATION.md](plugin/CONFIGURATION.md) documents the review-triage file
  (`.config/review-triage.yaml`) and every environment variable the skills
  read; the drive-pr README lists its tunable limits and every exit state.

### Changed

- Groundwork's content no longer names the organization it was extracted from,
  and code comments, test names and documents no longer carry review
  provenance (reviewer names, pull-request numbers and review rounds of the
  original repository). The rationale they annotated stays. The
  issue-tracker reference gate now also rejects the organization's name outside
  the repository's own address and publisher fields. An allow pattern exempts
  only the text it matches, not the rest of its line.
- M10's verified-pointer watchdog measures `AGE_SECONDS` as how long the
  oldest commit not yet verified has waited (`0` when the pointer is at the
  tip), not the age of the verified commit, which read a quiet branch as
  stalled. Copied recipes change their `AGE_SECONDS` line to the one in
  [mappings.md](modules/M10-environments-deploy/mappings.md).
- M11's `heartbeat` event requires the `emitter` it speaks for.
- The roadmap lists only work that is still open; finished phases are recorded
  here and in git history.
- Module READMEs end in a **Status** section (what the module provides, what
  it leaves out and why, what is future) and link the plugin skills that run
  their practice; the skills link back.
- The plugin README's installer-migration section is cut to the steps a
  repository still on a `v0.1.x-review-pilot` tag needs.

### Fixed

- M7's thread-state exporter reads the `wont-fix` verdict
  `resolve-review-comments` writes as `rejected`, instead of `unclassified`,
  which failed the unresolved-threads gate on correctly settled threads.
- Documentation that named files, flags, exit codes or configuration fields
  that do not exist, or described defaults wrongly, across the modules, the
  plugin and its skills.

### Removed

- The founding charter (`docs/founding-charter-2026-07-18.md`). It analysed the
  original repository's practices; what Groundwork took from it lives in
  [principles/](principles/), [modules/](modules/README.md) and
  [audit/](audit/README.md).

## [0.10.0] - 2026-10-12

### Added

- `decide` skill: settles a technical dilemma against the repository's existing
  decisions, then rules or escalates to a human with a cited decision sheet.
  Includes a TypeScript port of a Simplified Technical English linter
  (`ste-lint`), whose output matched the original Python implementation's on
  874 files.
- `explain` skill: writes a cited, commit-dated explainer sheet (HTML and
  Markdown) of how part of a system works today.

## [0.9.1] - 2026-10-11

### Fixed

- `drive-pr` on stacked pull requests: a round's validation plan and change set
  use the pull request's own base, so an upper layer's plan covers that layer
  alone, and a stacked layer's required checks are its base's plus those of the
  branch the stack's bottom layer targets.

## [0.9.0] - 2026-10-11

### Changed

- **Breaking:** the `do-issue` skill is renamed `do-item`
  (`/groundwork:do-item`), and its configuration section `do_issue` is renamed
  `do_item`. A `do_issue` section is no longer read; the skill stops and names
  the rename. Update instructions and configuration before machines update.

## [0.8.0] - 2026-10-11

### Added

- `issue_tracker.labels`: the label each role the skills act on maps to (epic,
  human-in-the-loop flag and facets, manual operations, review follow-up, bug,
  pattern prefix, batch sizes, the tails an epic may hand off).
- `issue_tracker.states`: the tracker's own state names, read by the
  parent-status reconciliation.

## [0.7.0] - 2026-10-11

### Added

- `pull_requests`: a declared policy for how agents open pull requests
  (stacking, stack depth, branch names, draft or Ready, when the drive marks a
  draft Ready, issue link, size budget, labels), applied by `do-issue`'s
  `pr-plan.ts`.
- [plugin/CONFIGURATION.md](plugin/CONFIGURATION.md): every configuration field
  in one reference.

### Changed

- **Breaking:** a repository that stacks pull requests must declare
  `pull_requests.stacking`; without it the skills refuse to stack.

## [0.6.0] - 2026-10-11

### Added

- Procedure skills: `review`, `fix-ci`, `github-actions`, `adr`, `descar`,
  `promote-memory`, `programmatic-execution` and `design-brief-builder`. Their
  shell and Python helpers are Bun scripts with tests.

## [0.5.0] - 2026-10-11

### Changed

- **Breaking:** the CI checks a drive waits for come from
  `ci.required_checks`, or by default from the base branch's protection, and
  the CI hold is opt-in through `ci.hold_label`. A repository that relies on
  the hold sets both before its machines update; a drive that still owns a hold
  label without that configuration stops and names the missing setting.
- The AI reviewer's check name and comment markers are `review.*` fields.

## [0.3.0] - 2026-10-10

### Added

- `drive-pr` skill: runs a pull request's review rounds unattended until it
  reaches one named end state, including its fleet-health and loop-metrics
  reports.
- `do-issue` skill: picks up a tracker item and carries it to a driven pull
  request, through a tracker interface with a Linear adapter.
- `review-arbiter` agent: rules on contested review findings.

## [0.2.0] - 2026-10-09

### Added

- The `groundwork` plugin for Claude Code and Codex, installed once per
  machine, with `resolve-review-comments` as its first skill. A repository
  commits only its values, in `.config/groundwork-overlay.yaml`.

### Removed

- The per-worktree installer (pinned release, host cache, rendered adapters,
  links and a git hook). The `v0.1.x-review-pilot` releases stay tagged for
  repositories that have not migrated.

## [0.1.1-review-pilot] - 2026-10-06

### Fixed

- The packaged review skill keeps its TypeScript type contracts.

## [0.1.0-review-pilot] - 2026-10-06

### Added

- First packaged release of the `resolve-review-comments` skill, installed per
  worktree from a pinned release.

[Unreleased]: https://github.com/docomply/jig/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/docomply/jig/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/docomply/jig/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/docomply/jig/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/docomply/jig/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/docomply/jig/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/docomply/jig/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/docomply/jig/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/docomply/jig/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/docomply/jig/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/docomply/jig/compare/v0.1.1-review-pilot...v0.2.0
[0.1.1-review-pilot]: https://github.com/docomply/jig/compare/v0.1.0-review-pilot...v0.1.1-review-pilot
[0.1.0-review-pilot]: https://github.com/docomply/jig/releases/tag/v0.1.0-review-pilot
