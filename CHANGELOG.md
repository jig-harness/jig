# Changelog

Notable changes to Jig (called Groundwork up to 0.11.0). The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A version number is the version of the `jig` [plugin](plugin/README.md)
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

## [0.13.0] - 2026-10-12

The plugin's scripts run on Bun only, and Jig's own code now passes a
ratchet: the findings it already has are tolerated, new ones fail the gates.

### Changed

- **Breaking:** the plugin's scripts run on Bun only. They were also
  documented to run with `node <script>.ts` on Node 22.18 or later; that is
  no longer supported or tested. A machine that started a script with `node`
  starts it with `bun`. Jig tests with Bun 1.4.3. `programmatic-execution`,
  whose analysis scripts run with whatever runtime a machine has, accepts Bun
  or Node 24 or later (was Node 22.18).
- Scripts recognise their own entry point with `import.meta.main`, so a script
  started through a symlinked path (a symlinked checkout, a skills directory
  of links) still runs.
- `review` lists every `Ratchet-Loosen` commit trailer in its summary for a
  person to confirm.
- do-item's scripts exit 1 with the error and its stack when an unexpected
  error escapes them, instead of leaving it to the runtime's unhandled
  rejection.

### Added

- M1's **ratchet gate**
  ([`reference/ratchet/`](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md)):
  counts findings per rule in the working tree and in the merge base, fails
  when a count grows or a configuration loosens a rule without a
  `Ratchet-Loosen: <rule>: <reason>` commit trailer, and reports rules ready
  to become errors. A loosening includes an override or a narrowed file
  scope, a reordered include list or override, any change to a setting it
  does not rank in a configuration file it already compares, a counter,
  configuration file or support path dropped or changed in the ratchet's own
  wiring, and a support path added there. M1's README places it between advisory and blocking.
- Jig's gates gain Biome rules (floating promises, misused promises,
  parameter properties, enums and namespaces as errors; empty blocks
  ratcheted), GritQL rules in `tools/quality/grit/` with their own
  fixtures (unchecked `JSON.parse` casts, `catch` blocks that drop the error
  and return a default, discarded child-process error output, local copies of
  record guards, `process.exit` where the command-line boundary sets the exit
  code, ad hoc
  process signal handlers), fallow (unused files, exports and dependencies;
  complexity and duplication of the changed files against the merge base),
  and stricter compiler settings (`erasableSyntaxOnly`, `noImplicitOverride`,
  `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`), with
  `exactOptionalPropertyTypes` ratcheted.

### Fixed

- This repository's own `.config/jig.yaml` labels its follow-ups `jig`
  (was `groundwork`, a label the tracker no longer has) and names `sourcebook`
  among the repository labels; the follow-up and epic labels move to
  `issue_tracker.labels`, and agents file issues through the Linear tool.
- `bun run typecheck` ran TypeScript 6, not the pinned TypeScript 7: a second
  package's `tsc` shadowed it. Type checking now uses `bun check`, which
  reports TypeScript 7's errors, and TypeScript 6 is no longer installed; the
  terminal-states consistency check uses TypeScript 7's compiler API.

## [0.12.0] - 2026-10-12

Groundwork is renamed **Jig**. Every machine and every repository that uses
the plugin follows the steps in
[Moving from the `groundwork` plugin](plugin/README.md#moving-from-the-groundwork-plugin):
on each machine, stop the drives, run `bun tools/plugin/setup.ts`, remove the
old plugin and rename the `GROUNDWORK_*` variables; in each repository, rename
the configuration file and the `/groundwork:` commands. **There is no
transition period: no old name is read, so nothing falls back and nothing
warns.**

### Changed

- **Breaking:** the plugin and both marketplaces are `jig@jig` (were
  `groundwork@groundwork`), and every command is `/jig:<skill>` (was
  `/groundwork:<skill>`); the review arbiter agent is `jig:review-arbiter`.
  `tools/plugin/setup.ts` installs `jig@jig` and does not touch
  `groundwork@groundwork`; remove that and the `groundwork` marketplace by
  hand. A repository that enables the plugin by id in `.claude/settings.json`
  changes the id.
- **Breaking:** the repository moves to `https://github.com/docomply/jig`;
  install commands, marketplace sources and links use the new address.
- **Breaking:** the configuration file is `.config/jig.yaml`
  (was `.config/groundwork-overlay.yaml`); the old file is not read, and a
  repository that still has only the old one is reported as unconfigured.
- **Breaking:** environment variables are `JIG_*` (were `GROUNDWORK_*`); the
  old names are not read. Variables only this repository's own tests and
  gates read (`JIG_GATES_SKIP_SEPARATE_SUITES`, `JIG_TEST_TMPDIR`,
  `JIG_BASH_PARITY`, `JIG_REQUIRE_BROWSER`, `JIG_MARKETPLACE`,
  `JIG_SETUP_TIMEOUT_SECONDS`) are renamed the same way.
- **Breaking:** default locations move from `groundwork` to `jig`, and nothing
  is read from the old ones: the drive state
  (`~/.local/state/jig/drive-pr/`, so a drive starts from empty state unless
  `migrate-state-dir.ts --from ~/.local/state/groundwork/drive-pr` moved it),
  the fleet-health snapshot folder (`~/.local/state/jig/dashboard`), the
  verification-fit log, the GitHub answer cache (`~/.cache/jig/gh-cache`) and
  the `resolve-conflicts` snapshot (`<git-dir>/jig/conflicts.json`). A
  machine that sets `DRIVE_PR_STATE_DIR` is not affected by the first.
- The roadmap queues the rename, the licence, skill assets in the plugin, the
  kickoff family of skills and a changelog skill ahead of the auditor skill.

### Added

- The Jig logo: a horizontal lockup heads the README, and the round mark is
  the plugin's icon in both tools (`assets/brand/`, `plugin/assets/`).

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

[Unreleased]: https://github.com/docomply/jig/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/docomply/jig/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/docomply/jig/compare/v0.11.0...v0.12.0
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
