# Changelog

Notable changes to Jig (called Groundwork up to 0.11.0). The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A version number is the version of the `jig` [plugin](plugin/README.md)
(`version` in `plugin/.claude-plugin/plugin.json` and
`plugin/.codex-plugin/plugin.json`), and each release is tagged `v<version>`.
Machines receive a change to the plugin only through a new version.

This file is written by the release step, not by hand. A pull request adds a
[change note](changes/README.md) under `changes/` instead; after the merge,
`scripts/release.ts` writes every note here and deletes it. A note that asks
for a release (every pull request that changes `plugin/` has one) becomes the
next version's section, and the step moves both manifests to that version
and tags it. Changes outside the plugin (modules, the auditor,
documentation) are listed under **Unreleased**. Why it works this way:
[ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md).

Before 1.0.0, a minor version can change behaviour that consumers rely on; such
changes are marked **Breaking** and say what a consumer changes.

## [Unreleased]

### Added

- `/followup`, Jig's own post-merge pass (`.claude/skills/followup/`): after
  a pull request merges, it reports what the merge still owes, with the
  evidence for each, and carries out what it may on its own. It covers the
  tracker item and its deferred findings, the release tags, on every merge
  (`scripts/release-tags.ts` lists every released version without an
  annotated tag on origin, at the commit that set it), the website (whether it deployed, and `scripts/site-diff.ts`, which
  builds the site before and after the merge and lists every page whose
  content changed, plus the hand-written text the merge should have changed
  and did not), the status pages and the documents that cite them, consumer
  repositories, and cleanup. Before the merge it lists what the merge will
  owe. The website's tests now fail when the factory page draws a roadmap
  item as not built after it has left the roadmap. Jig's own skills
  (`.claude/`) are now a high review-risk area, like the other agent
  instructions.

- `website/`: the jig-harness.dev site, an Astro build that renders this
  repository's documents as designed pages: the module map and a page per
  module (its levels with the audit's criteria, its mappings by CI
  provider), the software factory with its two figures, the adoption guides
  with a plan per profile and a hand-off link, the plugin, every skill,
  principle and glossary term, and what's new beside the roadmap, in light
  and dark, with search and term definitions in place (a module's pill
  opens its name and the problem it solves; an "i" beside a term of art such
  as *station* opens its glossary entry). Parsers read each
  kind of document and are tested against the real files; links land on the
  matching page or term, and the build fails on a broken one. The live audit
  example is rendered at build from a committed run. CI builds the site
  whenever the documents or the site change, and `main` deploys it as a
  Cloudflare Worker that serves it only to readers who opened a private
  link, so it can be shown to reviewers outside the team. Jig's mark now comes
  without letters too, square in light, dark and accent, for favicons and
  avatars. [design/website.md](design/website.md) has how it works and what
  is left.
- `/website-update`, one of Jig's own maintenance skills
  (`.claude/skills/`, not shipped in the plugin): it reviews every commit to
  `main` since the site was last checked (`website/content-sync.yaml`),
  fixes the site's hand-written copy, parsers and counts that a change left
  behind, in one draft pull request, files follow-ups for what is too large
  to review well, moves the record forward and reports.
  `bun scripts/website-sync.ts` lists the commits with their size and how
  each bears on the site, read from the change-area catalog; it marks those
  over 5,000 counted lines (`--max-lines`) for that call, reviewed when the
  parts the site renders are small enough. The context budget gate now also
  measures `.claude/skills`, in one session listing with the plugin's skills
  (M0's discovery check gains `--bare-skills` for that), and
  [CONTRIBUTING.md](CONTRIBUTING.md#jigs-own-skills) says where such skills
  live and how Codex finds them.
- Jig as a software factory: [FACTORY.md](FACTORY.md), which replaces
  `PLAYBOOK.md`, starts from what a factory of AI agents runs on, the
  repository's scaffolding for context, verification and kept knowledge, and
  which modules build each part, and how Jig fits an organization's own
  tools and values (modules, configuration layers, the tracker interface
  with Linear as its first adapter). It then maps the stations at the
  design-and-planning level (a feature or an epic) and the execution level
  (one work item), with what runs each station, what stays with a person,
  what is not built yet and what Jig leaves to the platform underneath. The
  README introduces the idea, and the glossary defines *software factory* and
  *PR (pull request)*.
- `tools/launcher/`: the issue tracker's "open in coding agent" button, as a
  machine-level tool. It assigns the issue to whoever opened it, saves the
  issue to a context file that `/jig:do-item` reads, picks the repository
  from the issue's label, and opens the workspace provider with the prompt
  (Conductor first, where a routed issue's agent starts once you click
  **Create**). Linear is the first tracker, behind a tracker interface.
  `install.ts` wires it into Linear's desktop app; its configuration is
  `~/.linear/launcher.yaml`.
- [design/reflection.md](design/reflection.md) describes the Notion store
  for reflections ([ROADMAP.md](ROADMAP.md) item 7) and a future Jira store.
  [design/](design/README.md) holds the designs of roadmap items until they
  are built.
- Every pull request re-evaluates the audit skill against its change
  ([CONTRIBUTING.md](CONTRIBUTING.md#keeping-the-auditor-current)).
  `bun run gates` fails until Jig's own audit record scores every current
  criterion and Jig's configuration exists, fits the audit's schema and has
  no unknown key in a Jig section (`scripts/check-audit-fit.ts`); the review policy flags a pull request that
  does not say what it changed in the audit.
- The parallel-workspace rules are written down, each with its reason: reuse
  a branch before creating one, never move work with `git stash`, install
  only with `bun install`.
- Jig's own pull-request lifecycle is written down: read the whole diff and
  run the gates before opening, open as a draft, mark it Ready after the first
  review round, merge only once a round after Ready has settled with the
  required checks green, and a person merges. `.config/jig.yaml` declares
  `drive.reviews_drafts: true`, the fact the draft-first order rests on.
- [design/changelog.md](design/changelog.md): the design of the opt-in
  `changelog` skill (roadmap item 4), which turns M12's change-notes
  reference into a plugin skill with its own configuration section, Keep a
  Changelog and Common Changelog, version files beyond JSON, two ways for the
  release to reach a protected branch, a guided setup, and the agent skills
  writing and keeping the notes.
- The factory on the site, redrawn and split into pages. Every actor is a
  chip that says what it is (`/` a skill, `@` the agent, `>` a tool, a
  silhouette for a person, a dashed chip for work not built yet) and opens
  what it does on hover, in the figures, the tables and the rendered
  documents alike. Figure 2 names what each station hands on, draws the
  follow-up return and the learning loop as the orbit around both levels; a
  third figure crosses every actor with every station; the scaffolding
  section places each verification module on the time axis of a session.
  The overview keeps the figures and the boundary; the scaffolding, each
  level and the learning loop have a page each, and every link into the old
  page lands on the section's new one.
- The site's plates (`website/public/plates/`): line drawings in the manner
  of a patent engraving, drawn in the ink token so they follow the theme
  (`Plate.astro` masks each file onto the text color). The factory page opens
  on a cross-section of a hall whose stations stand on scaffolding, each
  scaffolding job has its own plate, and the two levels, the learning loop,
  what stays with a person and what the platform supplies each have theirs;
  the home page's lede shows the jig itself; a faint scaffolding lattice
  lies behind sunk bands. [design/website.md](design/website.md) keeps the
  prompts and the conversion, so a plate can be drawn again.

### Changed

- Jig's own CI runs on Linux only for pull requests and pushes to `main`.
  macOS and Windows move to a new nightly workflow
  (`.github/workflows/nightly.yml`) that runs the gate set on both and the
  drive-pr suite on macOS against `main` once a day, or on demand for any
  branch. The Linux gate job is now `gate-set`; the required `gates` check is
  unchanged.
- Jig's own CI runs every job on Blacksmith runners instead of GitHub-hosted
  ones: Linux on `ubuntu-2404` (`gates.yml`), and in the nightly run macOS on
  `macos-latest` (Apple Silicon) and Windows on `windows-2025`. The gate jobs
  are named `gates (linux|macos|windows)`; the required `gates` check is
  unchanged. `.github/actionlint.yaml` declares the runner labels.
- M1's pull-request workflow template selects work in one resolver job
  instead of a change-detection step copied into each job. Its single required
  check is now an aggregator job that runs on `!cancelled()` (not `always()`),
  fails when a selected job failed or was cancelled, and names the jobs that
  did. Every job has a timeout, and event values reach scripts through `env:`.
  The template says why a required workflow is never path-filtered at trigger
  level: a skipped required job counts as passing.
- Jig's own `gates` workflow: the `gates` check runs on `!cancelled()` and
  names the jobs that failed, and every job has a timeout.
- M10's CI architecture and pipeline templates run a suite per change only
  when a merge or the `verified` pointer waits for it; slow suites nothing
  waits for, such as a full end-to-end run or coverage, run on a schedule or
  on demand with a cheap proxy per change. A new table says where each kind
  of suite runs.
- M9's issue templates put a gate-firing flag on the item that ships the
  change, never on its epic, and define an epic by its role rather than by
  how many children it has.
- M9's memory tiers keep all work state on the tracker, give the in-session
  tier its worktree scratch, warn that scratch is invisible to other
  worktrees, and define a handoff: Done, Remaining, Decisions, Uncertain, then
  a `Resume:` line. Work state has one authoritative store; a second one
  beside it is ruled out.
- M0 records which instruction files each agent runtime was observed to load.
  An import is not a pointer, and a nested instruction file extends its
  parent rather than relying on any runtime's precedence. Tool-specific files
  import the universal file where the runtime can.
- ROADMAP gains new modules (M13 pipeline economy, M14 testing strategy,
  M15 contracts and error handling) and the corrected designs for the existing
  modules.
- Website: the navigation item that opens the plugin guide reads "Install"
  instead of "Plugin", matching the page it opens; the factory page's
  learning loop and the skills page name `reflect` and `review-reflections`
  as the skills that run the reflection cycle, and the module index lists
  both under M8, so their skill pages carry its chip; the adoption guide's
  search entry finds its grandfathering section. The module map lists
  modules in id order, as the home page does, instead of the default
  adoption order with a rank beside each id; the adoption guide and each
  module's page keep the order.

### Fixed

- M6's changed-docs recipes (GitHub Actions and GitLab) read the changed
  documents the way M4's do: `git diff -z` into a file, with the
  `'docs/*.md'` pathspec. Documents directly under `docs/` are no longer
  skipped, names git would quote (non-ASCII characters, quotes, newlines)
  reach the checkers intact, and a failing `git diff` fails the step instead
  of reading as no changed documents. The GitLab recipe picks the sections
  manifest by stage directory, as the GitHub one does, so a document outside
  the stage directories no longer fails for want of a manifest. It also runs
  only in merge-request pipelines, fails under a shell other than bash, and
  extracts the base tree's gate scripts, with the `lib/` they import, into a
  fresh directory outside the merge request's checkout.
- M4's frontmatter-check test writes every temporary document and schema to
  a scratch directory outside the repository, so a suite that reads every
  Markdown file in the repository at the same time no longer fails on a file
  deleted mid-read.

## [0.34.0] - 2026-10-15

### Fixed

- Reflection no longer attaches a finding to another owner's class issue. The
  `pattern:<class>` label is shared by every repository filing into the same
  tracker team, so two repositories reviewing the same class used to land on the
  first one's issue. The `plan` of `/jig:reflect` and `/jig:review-reflections`
  now carries an `owner_marker` (`Jig owner: <owner>`, the owner
  percent-encoded): the issue filed for a
  class must carry it as a line of its own in the description, and the lookup
  attaches only to open issues that carry the asking owner's marker. A class
  issue filed before this change has no marker and is not attached to: the next
  escalation files a new one. The tracker port's `labelledIssues` can now return
  descriptions, and refuses an issue whose requested description is missing or
  neither a string nor an explicit null, rather than reading it as unmarked; an
  explicit null is an empty description and so carries no marker.

## [0.33.1] - 2026-10-15

### Fixed

- The drive-pr test that checks `RunHandle.stop()` empties the process group
  counts a zombie as gone, as `stop()` itself does. It reads the group from
  `/proc` where that answers and from `ps` otherwise, so on a host whose
  PID 1 reaps orphans late, a killed descendant still holding its
  process-table slot after `stop()` returned no longer fails the test.

## [0.33.0] - 2026-10-15

### Added

- `drive.max_rounds` sets a repository's default round budget for `drive-pr`
  (default `10`, as before). `--max-rounds` still overrides it for one run.
  Jig's own configuration sets it to 30.

### Changed

- Integer settings accept only whole numbers that can be represented exactly
  (up to 2⁵³ − 1). This applies to `drive.max_rounds`, `--max-rounds`,
  `pull_requests.size_budget`, `pull_requests.max_stack_depth`,
  `pull_requests.mark_ready`, and the audit's configuration check. A larger
  value used to be read as a rounded number and is now refused.
  **Breaking** for a `.config/jig.yaml` that sets one of these
  `pull_requests` values above 2⁵³ − 1: `drive-pr` reads the whole policy
  when it starts and stops with exit 1, and `do-item`'s pull-request plan
  refuses it too. Before upgrading, lower the value to 9007199254740991 or
  less, or delete it to use the default.

## [0.32.1] - 2026-10-15

Prose fixes to the PR review loop's skills. No configuration changes and no
script changes.

### Changed

- The triage rubric's guardrail on human-decided text also covers a fix that
  adds or changes a normative rule inside such a span while leaving the decided
  value as recorded. An unattended loop that accepted such additions one
  finding at a time extended a decision over several rounds until one addition
  contradicted the recorded amendment. A finding whose fix does this is never
  an ordinary accept: it is parked or escalated, or only wording that leaves
  the rule unchanged is accepted. The review arbiter's `fix-now` restriction
  says the same.
- `/jig:drive-pr` and `/jig:resolve-review-comments` say that `--tier` is the
  finding's rank in the rubric's priorities, taken from the kind of file the
  finding sits on and not from the PR's overall kind. The
  `resolve-review-comments` README states the same rule for human readers.
- `/jig:resolve-review-comments`' pre-reply checks include that each behaviour
  a reply asserts is in the staged diff, and that a temporal claim is tested
  after the boundary it names.
- `/jig:drive-pr` states that a drive likely to outlast the harness's
  background ceiling must start outside the harness, because the harness
  stops the command's whole process group at the ceiling.
- `/jig:drive-pr` tells the agent to close each reply-template heredoc on its
  own delimiter when batching calls (a mismatch posts the next command to the
  PR as the body), to stop and report when the worktree's branch is not the
  PR's head branch instead of renaming or checking out branches, to run each
  emitted plan check as its own command (a `set -e` script skips the checks
  after a failed non-last member of an `&&` list), and to re-read an
  inherited held thread reply against its thread before treating it as settled.
  That re-read comes before `finish-round.ts`, which drains every hold, and a
  mismatch is dispatched through `triage-thread.ts` after the fresh reply;
  `--cleanup-only` stays reserved for a human thread left open. An inherited
  summary-finding hold, which has no posted reply, has its held reason re-read
  against the finding before `finish-round.ts` too. On a mismatch the stale
  hold is released first, because parking leaves it in the held batch and the
  drain would post it, then re-held with the correct reason or parked.
- `/jig:drive-pr` names a separate terminal pane or a new session for a drive
  started outside the harness, because `nohup` alone leaves the command in the
  harness's process group.
- The glossary defines a human-decided span and its normative rules.

## [0.32.0] - 2026-10-15

### Changed

- M13's job timeouts are generous and capped. Every job has a timeout of about
  two to three times its slowest healthy run, because its work is to stop a
  hang, not to police a slow day; the workflow-convention lint's `job-timeout`
  rule now also fails a job above 60 minutes (a job that cannot be sharded
  carries a reasoned exception), where it accepted anything below the
  provider's six-hour default. The module, the copyable pipeline-economy page
  and the M1 workflow skeleton say the same.
- M14 enforces a tight tier budget on the suite's own command or step; the
  job timeout around it is M13's generous backstop and enforces a budget
  alone only when the budget is that loose.
- **Breaking** for a repository audited at Strict on M13: `/jig:audit` adds
  `M13/job-timeout-ceiling-linted`, which requires the CI-configuration lint
  to fail a job timeout written as a number above an hour unless a reasoned
  exception covers that job. A lint that accepts any value below the
  provider's default does not meet it; the comparison with an earlier audit
  reports it as added by Jig, not as a regression. To meet it, enforce the
  ceiling in the lint (M13's reference lint does) and register a reasoned
  exception for each job that cannot be sharded below an hour.
- `/jig:audit`: `M14/tier-budgets-enforced` observes that the bound
  enforcing a declared tier budget is no looser than it; a job timeout well
  above the budget is a backstop, not its enforcement.

## [0.31.1] - 2026-10-15

### Changed

- The plugin's update guide says a merge that changes `plugin/` is released
  as a new version by the release step on `main`, from the pull request's
  change note, instead of the pull request bumping the version itself.

## [0.31.0] - 2026-10-15

Pull requests stop conflicting over the changelog and the version: each adds
a change note, and the release is written after the merge.

### Added

- Change notes, [M12](modules/M12-parallel-agent-ergonomics/README.md)'s
  new core piece: a pull request records its changelog entry and the release
  it needs in a file of its own instead of editing the changelog and the
  version that every pull request edits, so merging one no longer puts the
  others in conflict. The portable form is
  [reference/change-notes/](modules/M12-parallel-agent-ergonomics/reference/change-notes/README.md):
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
- [ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md):
  a pull request adds a change note, and the release is written after the
  merge. ADR-0002 is amended to match.

### Changed

- Jig's own pull requests add a change note under
  [changes/](changes/README.md) instead of editing CHANGELOG.md or the plugin
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
  ([ADR-0003](docs/adr/ADR-0003-a-person-merges.md) is amended to match).

## [0.30.0] - 2026-10-15

### Added

- The [Notion store](plugin/skills/reflect/README.md#notion-store) for
  session reflection (`reflection.store: notion`): reflections in a Notion
  database people browse, filter and sort, from two settings, the
  integration's secret in `NOTION_TOKEN` and `reflection.notion.database`.
  `notion-store.ts init --parent <page>` creates the database with its
  properties and views and prints the setting. Each change gets one page
  (its issue key, else its branch, per repository), where every reflection
  adds a section with the session and its findings as readable text, and a
  decision adds a review note under its finding. Each event is kept on the
  page as a JSON code block in a collapsed toggle, which is all `list`
  reads; the page properties (Status, Severity, Classes, Repository and the
  rest) are recomputed from the events after every write, and
  `notion-store.ts repair` recomputes them after a failed write. A Status a
  person changed by hand is kept, and `diagnose` reports it until a decision
  agrees. `list` caches pages that have not changed since the last read, and
  requests keep to Notion's rate limit. The store passes the conformance
  suite against a local fake of the Notion API; a run against Notion itself
  is an opt-in test (`notion-live.test.ts`).
- `store-contract.ts`'s `runConformance` and the store client's `runStore`
  take the environment the store command runs in.

### Changed

- [design/reflection.md](design/reflection.md) now describes only the future
  Jira store; the Notion store is documented in the reflect skill's README,
  and roadmap item 7 holds only its run against Notion itself.

## [0.29.0] - 2026-10-15

M13's workflow conventions are checked by a gate instead of left to prose.

### Added

- [M13's workflow-convention lint](modules/M13-pipeline-economy/reference/workflow-conventions/README.md),
  the reference gate behind M13's Strict level. It reads the parsed GitHub
  Actions workflows and composite actions and fails a job without a timeout
  below the provider's default, a pull-request workflow without a cancelling
  concurrency group, a path filter on a workflow holding a required check, a
  required aggregator not on exactly `!cancelled()`, a heavy job without
  the CI hold's guard or a hold without a reachable sentinel that fails a
  required check, a
  heavy suite with a per-change trigger, differing environments across jobs
  that share a cache, a `uses:` not pinned to a commit SHA (or an image to a
  digest), push and pull-request path filters that differ or sit on only one
  of the two, and trigger paths
  that are not whole areas of the change-area catalog. Required checks come
  from `ci.required_checks`, or are derived as the jobs that need every
  other job of their workflow; heavy suites and cache groups are declared
  in its own configuration. Every
  exception carries a reason, one that suppresses nothing fails the lint, and
  input it cannot parse or that is malformed (a repeated key, an empty
  `jobs:`, an action without `runs:` included) exits 2. Whether GitHub
  accepts a value, such as a cron expression or a Node runtime, stays
  GitHub's check and a workflow linter's. Jig's workflows
  pass it in `bun run gates`, with `nightly.yml` declared heavy and no
  exception.
- `lib/workflows.ts`: the one reader of workflow files, shared by M7's
  PR-target safety lint and the workflow-convention lint.

### Changed

- `/jig:audit`: `M13/workflow-conventions-linted` now requires the lint to
  fail closed on a file it cannot parse, to accept only reasoned exceptions,
  and to fail on one that suppresses nothing; it names the cancelling
  pull-request concurrency group among the conventions instead of a
  concurrency key that drops runs, which a lint cannot judge. Jig's record
  keeps its scores; the next audit re-scores it, with this change targeting
  `M13/workflow-conventions-linted` and
  `M13/no-required-pipeline-path-filtered`.
- `/jig:github-actions` names a workflow-convention lint among the checks a
  repository may already run.

## [0.28.1] - 2026-10-15

### Fixed

- The audit sheet keeps the reader's place when Back or Forward comes while
  the smooth scroll of a link just followed is still running: the page no
  longer keeps part of that scroll and ends a few pixels (up to a few
  dozen) from where the entry was left. The browser check for a position
  scrolled to just before Back, which failed about one run in five, now
  waits for that smooth scroll to end before it scrolls, and a second check
  covers following a link and going Back at once. The corrected jump never
  overrides a later move: following another link before it is made, or
  scrolling on purpose, drops it. Only a jump made before the input is
  dropped: Escape leaving the guide keeps the way back it makes itself.

## [0.28.0] - 2026-10-15

### Added

- Session reflection, as two skills with a pluggable store.
  [`/jig:reflect`](plugin/skills/reflect/README.md) records what a session
  learned about the repository's scaffolding: findings are captured in a
  per-worktree journal as they happen (`journal.ts note`), and at a natural
  end the skill merges duplicates, names each finding's class, escalates a
  class that recurs `reflection.escalate_after` times to one tracker issue
  labelled `pattern:<class>`, and contributes the rest to a store every
  repository on the machine (or in the team) shares.
  [`/jig:review-reflections`](plugin/skills/review-reflections/README.md)
  reads the findings the repository it runs in would fix (in Jig, every
  finding about Jig's skills from every repository), reconciles approved
  fixes with what merged, groups what recurred, proposes a change per group,
  and records each decision once a person approves. The records are an
  append-only log of findings and decisions, each with the session that
  wrote it (Jig version, skills, harness, model, and which of those the agent
  stated), and a finding's status and a class's recurrence are computed from
  it. A store is any command that answers the store contract (`check`,
  `append`, `list`, `diagnose`); `store-contract.ts` is its conformance
  suite, and the plugin ships a filesystem store (a folder of JSONL files,
  one per write, so synced or shared folders merge without conflicts).
- The `reflection` configuration section
  ([CONFIGURATION.md](plugin/CONFIGURATION.md#reflection)): its presence in
  any layer turns reflection on, normally in `~/.jig/jig.yaml`.
- M8's invariant now says reflection records are append-only, carry an id,
  and have their state computed; its mappings list the reflection stores.
  M12's worktree-remove hook parks a worktree's unsent findings for the next
  reflection, and refuses the removal when it cannot.

- The plugin's requirements name git 2.36 as the minimum, the first version
  with both options the scripts use: `--path-format` and
  `git worktree list -z`.

### Changed

- **Breaking:** `/jig:drive-pr`'s `reflectDue` and `$DRIVE_PR_REFLECT_DUE`,
  and `/jig:resolve-review-comments`' wind-down prompt after a long review,
  fire only when reflection is on, and ask for `/jig:reflect` rather than a
  repository's own `/reflect`. The wind-down also notes the round count in
  the reflection journal. A repository that relied on that nudge to run its
  own `/reflect` stops being nudged until a configuration layer has a
  `reflection` section: add one (`reflection: {}` uses the defaults) to keep
  it.
- The Linear tracker's requests can be cancelled. `labelledIssues` and
  `postComment` take an `AbortSignal`; a cancelled signal ends the request in
  flight and starts no further page. The `linear` command-line client now
  runs without blocking, so a caller's timer fires while it runs, and the
  client is stopped when the signal is cancelled or the calling process is
  terminated.

## [0.27.1] - 2026-10-15

What can be adapted in Jig, and how, in one place. No behaviour changes.

### Added

- [plugin/EXTENDING.md](plugin/EXTENDING.md), and its page on the site
  (`/plugin/extending/`): the ways a repository adapts Jig (a value, a
  command of its own, an implementation behind an interface, a row in a
  module's mappings); the commands a repository supplies, with their
  contracts; the tracker interface and how to add an adapter, with what
  still assumes Linear; reflection stores; AI reviewers; what depends on
  GitHub as the forge and on GitHub Actions as the CI system; the agent
  tools; the launcher's providers; which parts run on which operating
  system; and how an extension is contributed. Each limit names the roadmap
  item that would lift it.
- The roadmap's later work gains a forge interface, a CI provider for
  `fix-ci`'s log download, and Windows support for `drive-pr` and `do-item`;
  item 12 names the operations the tracker interface needs before a second
  adapter works end to end, and item 10 the fields named after Linear.

### Changed

- The plugin's [requirements](plugin/README.md#requirements) give minimum
  versions: git 2.36, the GitHub command line 2.48, Claude Code 2.1.285 for
  a drive's long background commands, and say that `do-item` is not tested
  on Windows.
- [Where it works](plugin/README.md#where-it-works): a tool without plugin
  support takes every skill folder side by side, since skills import
  scripts from their siblings.


## [0.27.0] - 2026-10-14

A new module, [M14 Testing strategy](modules/M14-testing-strategy/README.md),
and the audit criteria that score it. Nothing a consumer has configured stops
working; a re-audit reports the new criteria as added since the prior audit.

### Added

- [M14 Testing strategy](modules/M14-testing-strategy/README.md): test tiers
  with a trigger and a time budget, the full end-to-end sweep kept off the
  per-change path by a check, honest test doubles proven by a mutation check,
  an injected clock with a lint rule, polling with a deadline instead of
  fixed sleeps, isolation predicates tested against the real engine, typed
  test-data builders, type-checked tests, tests with every change, tests kept
  off the developer's real state, and coverage as a scheduled trend rather
  than a per-file gate. It ships a testing-strategy template, a
  tests-with-changes gate (base ref, source globs, test-path templates and an
  exemptions file as arguments) and a polling helper, each with a self-test,
  and per-ecosystem mappings for TypeScript, Python, Go, the JVM and .NET.
- AGENTS.md § Rules for every change states Jig's own testing rules: tests are
  type-checked, a test that needs another home directory, working directory
  or environment spawns a subprocess, waits poll with a deadline, and a new
  test is seen to fail first; M14 has the rest.
- `/jig:audit` scores M14's criteria (`since: 0.27.0`); its
  automation survey asks about tiers, budgets and the other testing rules.
  Team/Standard targets M14 Lite and Regulated/Strict M14 Standard; M14 comes
  after M7 in the adoption order.

### Changed

- `score.ts --check` checks the modules listed in `MODULE_IDS` rather than a
  contiguous `M0`…`M<n>` range, so a planned module number can stay open
  while that module is written.
- The execa calibration record scores M14's criteria against the same
  commit, so the website's audit example renders a complete record.
- M1 lists M14's `fixed-delay:` token and tests-with-changes exemptions file
  as suppressions for its registry; M10 tells its test-data factory apart
  from M14's typed builders.

## [0.26.0] - 2026-10-14

### Added

- M3 catalog rules for seeds versus dependency closure, agent gate depth,
  generated-output coupling, externally corroborated code-bearing anchors,
  and an independent catalog self-check trigger. The auditor's M3 criteria
  now cover these facts; shortcut-only criteria use `expected-absent` where
  the repository has no shortcut.
- A brownfield coverage-gate adoption pattern with frozen exceptions,
  partial-coverage pins and a live owner, also shown on the site's adoption
  page.

## [0.25.0] - 2026-10-14

A new practice module, M13 Pipeline economy: spend CI only where it changes
a merge decision, and never let a saving turn a failure into a pass.

### Added

- [M13 Pipeline economy](modules/M13-pipeline-economy/README.md): six
  sub-invariants (honest signal first, select, supersede, bound, order and
  parallelize, place), their GitHub Actions and GitLab CI mappings, a
  copyable policy page with the placement table, and a queue-stall watchdog
  (a reference check with its self-test and a scheduled workflow), because
  job timeouts do not count time spent waiting for a runner.
- `/jig:audit` scores M13's nine criteria (Lite: superseded pull-request
  runs cancelled, a timeout on every job, no required pipeline filtered by
  paths at its trigger; Standard: a catalog resolver drives selection, one
  aggregated required check, slow suites nothing waits for on a schedule;
  Strict: the conventions linted, CI cost measured, a queue-stall watchdog).
  Team/Standard and Regulated/Strict aim for M13 Lite, so a re-audit reports
  M13's criteria as added by Jig.

### Changed

- The execa calibration record scores M13's criteria against the same
  commit, so the audit's tests read a complete record.
- `/jig:github-actions`' performance checks name M13 as the practice they
  apply, and collect coverage on a schedule unless a coverage threshold
  gates the merge.
- M10's CI-ARCHITECTURE template links to M13's placement table instead of
  carrying its own copy; M1, M3, M7, M10 and M11 link to M13 where they
  touch it.

## [0.24.0] - 2026-10-14

The plugin reads the change-area catalog through one reader.

### Added

- `drive-pr/scripts/lib/change-areas-catalog.ts` is the plugin's one reader
  of the consumer's change-area catalog (`drive.change_areas_catalog`). It
  matches a path to the areas whose own `paths` (and `generated[].source`)
  match it, and returns each area's `tracker.labels` (alone, and joined to
  the area's own `labels`) and `tracker.flags`, reading `linear.labels` and
  `linear.flags` as the older spelling. It is step 3 of the `work-batch`
  build order ([design/work-batch.md](design/work-batch.md)): the batching
  skill will read area flags through it.

### Changed

- `fleet-health`, `verification-fit.ts`, `determine_agent.ts` and
  `resolve-conflicts` use that reader and its one path-glob matcher instead
  of their own. `resolve_conflicts.generated` globs now also understand
  `{a,b}` and `[...]`, as catalog globs always did; `[!...]` and `[^...]`
  both negate a class, and a `]` first in a class is one of its members. A
  `[...]` class no longer matches `/`, so it stays within one path segment
  as `*` and `?` do, and `**` now also matches a path whose name contains a
  newline.
- **Breaking** for a catalog with a malformed area (for example `paths:`
  that is not a list of strings, or a glob such as `src/{a,b` that compiles
  to no pattern): `verification-fit.ts` now stops on it with the field at
  fault, and `determine_agent.ts` routes by labels alone and prints
  `Catalog unavailable, routing by labels only: <reason>` on stderr.
  `resolve-conflicts` refuses such a glob in `resolve_conflicts.generated`
  with exit 2. Fix the field the message names.
- **Breaking** for the fleet-health sensor, which already refused a catalog
  whose `paths`, `generated` or `labels` were malformed: it now also refuses
  one whose `tracker.flags` or `linear.flags` is not a list of strings, and
  compiles every glob when it loads the catalog rather than only the globs a
  path reaches. A catalog it refuses leaves merged PRs unclassified, so no PR
  counts as product progress and the delivery-system share is not measured.

## [0.23.0] - 2026-10-14

### Added

- M4's stale `last_updated` gate
  ([reference/stale-last-updated/](modules/M4-docs-governance/reference/stale-last-updated/README.md)):
  a diff that changes a document's body must advance `last_updated`, or leave
  it at today's UTC date. It runs over a CI diff range (old side at the merge
  base for `A...B`) or the staged changes in a pre-commit hook, skips a file
  a merge carries unchanged from one side, and prints a `SKIP` note in CI when
  no range is given. It compares the two sides' bodies and their dates as the
  shared frontmatter reader parses them, never a patch. A renamed document is
  compared with its old path and only an added one is exempt. Frontmatter
  removed, left unclosed or unreadable on the new side fails, so does a
  document that is not a regular file on both sides (replaced by a symlink),
  and only a calendar date counts as a bump. Two cases have no date to hold:
  a document with no frontmatter on either side passes, and an old side the
  reader rejects has no date, so the commit that corrects it passes on any
  calendar date. A side it cannot read, an unresolvable, one-sided or doubled
  range (in every mode), `--staged` with `--range=`, a named path outside the
  repository, or an unknown option exits 2. A body line starting
  `last_updated:` or a comment added to the date is not a bump.
- Sticky UTC stamping for generators
  ([reference/stamp/](modules/M4-docs-governance/reference/stamp/README.md)):
  a generator writing into the docs tree advances `last_updated` only when its
  output changed, so it neither breaks the stale gate nor churns dates. It
  reads the date through the shared reader and refuses frontmatter that
  never closes or that reader reports an error in, with or without a
  `last_updated` line, or a `last_updated` whose value continues past its key
  line, rather than stamping it half-replaced.
- M4's index generator writes an orphan report, `.orphans.md`, beside
  `INDEX.md`: the documents no other document lists under `related:`. It is a
  warning, never a failure; `--check` fails when either file is stale, and
  the report's date is sticky so the check gives the same answer on any day.
  A `related:` entry starting with `/` resolves from the repository root,
  report links resolve from the report's own directory, and the report's
  frontmatter values can be set through `ORPHANS_*` variables.
- Path-scoped frontmatter rules: `path_rules:` in the schema adds required
  fields, narrowed values and forbidden body text (outside code fences) for
  the documents under a path prefix. A rule that cannot be evaluated, or
  whose prefix matches no document in the tree, fails the check. The schema
  template carries neutral examples, commented out for adopters to adapt.
- M4's adoption steps say to bring existing docs into line with a codemod
  (survey, plan, then apply, one commit per mapping family, singletons to a
  triage list) before tightening a validator.
- `/jig:audit` scores new M4 criteria: `frontmatter-subset-declared`,
  `generators-stamp-sticky-utc`, `orphan-report-generated` and
  `path-rules-enforce-subtree-vocabulary` (expected-absent where no subtree
  needs rules of its own). `stale-doc-gate` names what its check must
  observe.
- The glossary defines *path-scoped rule*, *orphan document*, *sticky
  stamping* and *codemod*.

### Changed

- M4's frontmatter reader reads an explicit YAML subset and reports each
  construct outside it (tabs in indentation, anchors, tags, explicit or
  quoted keys, flow mappings, nested mappings, multi-line plain values,
  duplicate keys, unterminated quotes, values starting with a character YAML
  reserves, escapes YAML does not define in a double-quoted value, characters YAML
  does not allow such as control characters) as a violation with its line,
  instead of guessing. Whitespace is YAML's (space and tab, so U+00A0 is
  content) and a carriage return on its own ends a line, in every M4 script
  that reads a document: the stale gate, sticky stamping and the scar lint
  find the same frontmatter and lines the reader does. Block scalars keep YAML's indentation, folding and
  chomping. The self-test checks block scalars and one-line values (plain,
  quoted, in a list) against a YAML parser over every combination of a set of
  line shapes and characters. Trailing comments are cut
  quote-aware, `null`, `~` and blank
  values count as absent for a required field, and `tags` may be a block
  sequence as well as `[a, b]`. The subset is listed in the checker's
  README and the `WIKI-SCHEMA.md` template. **Breaking** for docs using a
  construct outside the subset: rewrite it inside the subset (the README
  lists both sides).
- M4's frontmatter checker parses the whole schema with js-yaml from
  `lib/vendor/` and reads every section from the result, so any YAML spelling
  counts (`required: [title]` included) and a section of the wrong shape fails
  the check instead of dropping its checks. **Breaking** for a copy of
  `reference/` without Jig's `lib/vendor/` beside the `modules/` folder that
  holds it (Jig's own layout): the checker exits 2 there; vendor `lib/` or run
  it from a pinned Jig checkout. `last_updated` and `decision_date` must be
  calendar dates, not only `YYYY-MM-DD` in shape. A section set to `null`
  is a schema error, not an omitted one, and a schema that cannot be read
  exits 2. The generated `INDEX.md`, which has no frontmatter, is left out:
  the file at the generator's index path (`$OUT`, else `INDEX.md` in
  `$DOCS_DIR`) that opens with its marker; the marker exempts nothing at any
  other path. A schema section
  must be a mapping where one is expected: a date
  or binary value is an error. `NEW_DOCS` lists one path per line, and an
  entry naming no checked file fails the check. **Breaking** for a
  space-separated `NEW_DOCS` of more than one file: put one path per line.
- M4's CI recipes ([mappings.md](modules/M4-docs-governance/mappings.md))
  pass the base branch and file names as data, never into the shell program;
  check renamed documents at their new path; check every document when the
  schema changes; select their own work instead of filtering the GitHub
  trigger, so the check reports on every pull request; and name the scripts
  under `<m4>`, a Jig checkout or a copy that keeps Jig's layout. File lists
  come from `git diff -z` through a file, so names with spaces or non-ASCII
  characters survive and a failing `git diff` stops the step; the pathspec
  `'docs/*.md'` covers documents directly under `docs/`, which
  `'docs/**/*.md'` misses; and a vendored checker's paths (`VENDORED`) feed
  both the work selector and the whole-tree comparison.
- M4's index generator and scar lint refuse a document whose frontmatter is
  present but outside the subset (exit 2) rather than reading part of it. The
  index leaves out only the generated index and report (a nested `INDEX.md`
  is a document), writes each title and description as one table cell,
  rejects an unknown argument, and refuses `OUT` and `ORPHANS` naming one
  file. An ADR's `decision_date` needs a value; only `supersedes` and
  `superseded_by` may be `~`, and a blank one is missing.
- M4's scar lint reports a named file it did not scan (not `status:
  approved`): `NOT SCANNED` when none of the named files is promoted, and a
  `NOTE` listing the skipped files beside `OK` or the scar report. A run over
  the whole tree still prints plain `OK`. `/jig:descar` says so.

## [0.22.0] - 2026-10-14

M0 states that instructions must reach each runtime, and that what every
session loads is a budget. Nothing a consumer has configured stops working.

### Added

- [M0](modules/M0-instruction-architecture/README.md) gains the invariants
  **delivery is observed** (a rule reaches a runtime by an import or a file it
  reads natively, the load model is recorded with dated evidence and a way to
  re-check it, precedence is a written convention, and parity is judged by
  what each runtime receives) and **always-loaded context is a budget** (the
  chained instruction files, unscoped rules, skill and agent discovery
  metadata and MCP server instructions are measured against the smallest
  consumer's budget, and text past it counts as undelivered). Its
  [mappings](modules/M0-instruction-architecture/mappings.md) list each
  runtime's and reviewer's budget with the date it was checked, where the
  always-loaded surface lives per runtime, and a CI recipe that runs before
  dependencies are installed.
- M0's [context-budget checks](modules/M0-instruction-architecture/reference/context-budget/README.md):
  `check-instruction-chain.ts` fails any root-to-directory `AGENTS.md` chain
  over the smaller of the configured `project_doc_max_bytes` and the
  consumer budget (32,768 bytes by default), and `check-discovery-budget.ts`
  checks skill and agent descriptions against the 1,024-character cap, the
  512-character soft target and the 1,536-character combined cap, and the
  skill listing against 8,000 characters, path-scoped skills included. Both
  use only Bun's built-ins.
- `/jig:audit` scores the new M0 criteria `load-model-recorded` (Standard)
  and `context-budget-gated` (Strict, mechanical).
- `bun run gates` runs the context-budget checks over Jig first (the plugin's
  skills must meet the 512-character soft target), and CI runs them before
  installing dependencies.

### Changed

- `/jig:audit`'s description is shorter (471 characters, within the soft
  target); the detail it dropped is in the skill's body.
- A pointer line no longer counts as bringing in the universal instruction
  file. M0's layers and `/jig:audit`'s `tool-deltas-are-pointers` criterion
  accept an import or the runtime's native read; where a runtime has
  neither, the delta is generated from it and checked for freshness (a
  projection, not a hand-kept copy), or the gap is recorded in the load
  model. A repository whose tool file only points to `AGENTS.md` scores
  lower on that criterion at its next audit.
- [plugin/README.md](plugin/README.md) § Add or change a skill states the
  512-character description target and the 1,024-character hard limit.

### Fixed

- The audit sheet owns history scroll restoration: each history entry keeps
  its own position under a key in its history state, recorded as the reader
  scrolls and when they leave, so Back, Forward and a reload return the reader
  to where they were in that entry, in the report and in its guide alike. Only
  the most recently used positions stay in memory; an older entry restores from
  its history state, and a position not yet written there is kept in
  preference to one that is, within the same bound.
- A re-audit reports a criterion whose `since` is newer than the prior
  audit's plugin version as added by Jig even when the prior record carries a
  score for it, so a criterion filled in after the fact is not reported as a
  long-standing gap.

## [0.21.0] - 2026-10-14

### Added

- M1 states that a gate has three outcomes: passed, found violations, or
  could not check (exit 0, 1 and 2). A gate never turns input it could not
  find or read into a pass, and a skipped or stale result is never evidence
  that a change passed. An input empty where its format requires content
  fails closed; one whose format allows zero entries may pass empty, and the
  gate says it examined zero. The glossary defines *fail closed*, *could not
  check*, *mutation testing* and *shadow job*.
- M1's gate-authoring rules (core piece 3, which replaces "a grep with a
  self-test outlives an AST analyzer"): fail closed on a missing or empty
  section, an undecodable row, a repeated key or a failed command; count the
  population read; answer a question about whether code runs or a value binds
  with a real parser or an exact pinned text, never a guessed pattern; keep a
  self-test's recognizer broader than the gate's; mutation-test every fixture,
  each clause of a fail-closed chain alone; state the verdict's scope on green
  runs too; and give each finding its rule, place, problem and fix, written
  as an annotation in CI. [mappings.md](modules/M1-gates-enforcement-ladder/mappings.md#actionable-findings-in-ci)
  maps GitHub's `::error` command and GitLab's Code Quality report.
- M1's exceptions prune themselves: every suppression token and allowlist
  entry carries a reason the gate checks, and one that suppresses nothing
  fails the gate. The suppression-registry template gains a "Stale when"
  column, and its allowlist row requires a checked reason.
- M1's gate lifecycle: a recurring syntactic review finding becomes a
  fixture-tested lint rule under the ratchet, with bulk rewrites by a tool that
  never gates; a replacement tool runs in a non-blocking shadow job with
  published parity counts before it takes over; a retired gate records what
  replaced it and the coverage lost; unused code and duplication are measured
  on every change from entry points declared one by one.
- `/jig:audit` scores new M1 criteria: `gate-outcomes-distinguish-could-not-check`
  and `stale-exceptions-fail` (Standard), and
  `gate-self-tests-cover-empty-input` (Strict).
- `lib/findings.ts`: the shared finding format, GitHub annotations with the
  workflow-command escaping, the could-not-check report, and the reasoned
  exception-list reader.

### Changed

- M1's grep-gate reference exits 2 when its scan root is missing or holds no
  text file (it passed before), states its scope on green runs, prints each
  finding with its rule, file and line, problem and fix, writes `::error`
  annotations under GitHub Actions, and fails on a `todo-exempt:` that
  suppresses nothing. It counts each TODO on its own, so a TODO citing an
  issue no longer clears a bare TODO on the same line, and a TODO inside a
  cited issue key is part of that citation. **Breaking** for a copy of the gate run on a folder
  that may not exist: point `SRC_DIR` at a folder with source in it.
- Jig's own gates follow the rules: the Markdown, glossary, origin-reference,
  instruction-path, workflow-safety, licence, change-area and audit-fit checks
  exit 2 when they read nothing, and every check states its scope when it
  passes.
  The Markdown, glossary and origin-reference checks write findings in the
  shared format with annotations. The glossary allowlist and the
  origin-reference allow patterns need a reason per group and fail on an
  entry that suppresses nothing (20 stale glossary entries are gone). The
  change-area and review-risk checks and M7's PR-target safety lint, which
  Jig's workflow-safety check runs, reject a repeated YAML key. The ratchet
  exits 2 in CI without a merge base, and the gates M1 does not yet bring in
  line are listed in [M1 § Jig's own gates](modules/M1-gates-enforcement-ladder/README.md#jigs-own-gates).
- `/jig:fix-ci` reads a gate's "could not check" (exit 2) as a problem with
  the gate's input or environment, not with the code, and applies the fix a
  finding names.

## [0.20.0] - 2026-10-14

### Added

- M10 states how a promotion executes
  ([README § Promotion execution](modules/M10-environments-deploy/README.md#promotion-execution)):
  the gated commit is the shipped commit (the first job resolves the
  `verified` pointer once and every later job takes the commit from its
  output; promotions to one environment never drop a queued request and wait
  for every earlier one, refusing a re-run and checking again before the
  migration; the promotion
  and its gate code run from the trusted ref, the only ref the production
  environment admits);
  build once (the verified artifact is promoted by digest, with
  per-environment settings supplied at deploy time); post-deploy identity (a
  deploy is complete only when the live environment reports the promoted
  identity, its rollouts are ready and a readiness check of its critical
  dependencies passes, each under a deadline, and downstream work reads a
  manifest of what deployed); and release state off the source line (release
  pointers only fast-forward, after the identity check, and refuse a gated
  commit older than themselves; rendered
  deployment state lives on its own ref written by one machine identity that
  branch protection admits). The CI-architecture and pipeline templates gain
  the gate's commit output, a verify-identity step and a deploy manifest after
  every deploy, and advance the release pointer last;
  `mappings.md` maps digest pinning, runtime configuration, Argo CD and Flux,
  GitHub's concurrency semantics, rollout checks and the identity check.
- M10's promote-safety lint gains rule (c): a production deploy job fails when
  it selects its commit by name (a `ref:` or `--ref` naming a branch or a
  branch-shaped expression such as `inputs.branch`, or a run step's `git
  fetch`, `pull`, `checkout`, `switch`, `reset`, `merge`, `rebase` or
  `rev-parse` of a name) instead of an upstream job's output. The `verified`
  pointer by name is accepted only in a job with no upstream job (in GitLab,
  a later stage is upstream unless the job says `needs: []`), resolved
  there once, and a `git fetch` of a ref the job pushes to (its rendered-state
  ref) is not a selection when a publishing push from the same repository to
  the same remote writes it. Git commands are recognized however git is
  spelled, after global options and inside nested substitutions; only a
  command at a command position, outside quoted text and heredoc bodies, in a
  repository its own text establishes, can grant an exemption; a remote
  `HEAD`, an ancestor such as `HEAD~1`, and a `FETCH_HEAD` of unknown origin
  count as names. The shapes a line matcher still misses (a command that may
  not run, a verb spelled with quotes, a fetch that keeps `FETCH_HEAD`, a
  control word used as an argument) are
  listed under its Known limits. Option arity follows the git verb, ref names keep
  their case, and a `#` inside a quoted string does not start a comment.
- `/jig:audit` scores new M10 criteria: `artifacts-built-once-promoted-by-digest`
  (standard), `promotions-serialized-from-trusted-ref`,
  `deploy-verifies-live-identity` and `release-state-off-source-line`
  (strict). `deploys-verified-artifacts-only` also observes that later jobs
  of a promotion take the commit from an upstream output.
- The glossary defines *digest*, *build once*, *GitOps*, *rendered state* and
  the *post-deploy identity check*.

### Changed

- `/jig:github-actions` describes the deploy and promotion stages with the
  digest, the trusted ref, one promotion at a time and the identity check.

## [0.19.1] - 2026-10-14

### Changed

- The plugin's README says a suite too long for the gate job gets its own
  sharded job in both the gates workflow and the nightly workflow.

## [0.19.0] - 2026-10-13

### Added

- M9 states the work-item rules
  ([README § Work-item rules](modules/M9-tasks-memory/README.md#work-item-rules)):
  an epic closes on an accepted verdict or a recorded waiver, never on its
  count of open children, and hands off its tails with a link back; a flag
  that fires a gate goes on the item that ships the change; labels carry
  durable classification only; every filing path sets priority and category
  at birth, the priority from one severity mapping and the category checked
  against one category list; copies of the taxonomy's key sets are
  checked for exact equality; prioritization is computed and a person picks.
- `/jig:audit` scores new M9 criteria: `gate-flags-scoped-to-shipping-item`,
  `epic-closure-requires-acceptance` and `issues-prioritized-at-creation`.
  A declared flag scope counts as convention, and a ranker that is only
  planned is not credited.
- `/jig:audit`'s configuration check compares the explicitly configured
  `issue_tracker.labels` (and the older `review.taxonomy.epic_label` and
  `provenance_label`) and `review.taxonomy.types` with the repository's
  `label-taxonomy.yaml`, when it has one. A taxonomy whose sections are
  malformed leaves the labels unchecked rather than reading as empty.

### Changed

- M9's label-taxonomy lint requires every flag to declare its `scope`
  (`shipping-item` or `container`) and `apply_when`, and accepts
  `do_not_apply_when` and `requires` (labels a flag may only appear with).
  **Breaking** for a taxonomy copied from the template: add `scope` and
  `apply_when` to each flag. The lint now parses the file as YAML with
  js-yaml, vendored in `lib/vendor/`, so every spelling of an entry is
  checked, a repeated key is rejected, and a field that is not text (a null
  list member, a list-valued id) is reported rather than read as absent.
  A copy of `lib/` must now include its `vendor/` folder.
- M9's taxonomy template gains an `epic` flag, and its statuses are
  `do-item`'s canonical states (`backlog`, `ops-pending`, `canceled` and
  `duplicate` added; `blocked`, a relation between items, removed).
- `/jig:do-item` closes an epic only on its newest verdict accepting it, or
  on a waiver while that verdict is not a rejection, including when every
  sub-issue is done; without either it moves the epic to `in_review`. An
  extracted tail gets its backlink and a comment naming the epic before it
  leaves the epic.

## [0.18.3] - 2026-10-13

### Fixed

- A drive armed from an unattended Claude Code session (`claude -p`, the Agent
  SDK, a cloud or scheduled session) was stopped after 30 minutes (10 in a
  `claude -p` run whose prompt is passed as text), partway through a round,
  because the harness limits background commands to that unless the agent
  passes a `timeout`, and to 2 hours at most. `/jig:drive-pr`
  and `/jig:do-item` now tell the agent to spawn the driver with a `timeout` of
  8 hours. The ceiling is the machine's to raise: set `BASH_MAX_TIMEOUT_MS` to
  `28800000`. A drive longer than 8 hours (a long quota sleep, many rounds)
  is still stopped there and resumes when re-armed. [drive-pr's README](plugin/skills/drive-pr/README.md#the-background-time-limit)
  explains the limit, what a stopped drive leaves behind and how to resume it,
  and [CONFIGURATION.md](plugin/CONFIGURATION.md#environment-variables) lists
  the variable.

## [0.18.2] - 2026-10-13

The work from Jig's audit of 2026-10-13, a lean AGENTS.md (it keeps the
rules every session needs and points to [CONTRIBUTING.md](CONTRIBUTING.md)
and [docs/](docs/README.md) for the detail), and Jig's licence. No consumer
change.

### Added

- Jig is licensed under the Apache License 2.0 ([LICENSE](LICENSE)), with the
  module templates under MIT No Attribution ([LICENSE-MIT-0](LICENSE-MIT-0))
  so a repository can copy them without a notice. [NOTICE](NOTICE) names the
  licensor, the template files and the vendored third-party code with its
  licences; the plugin carries copies of LICENSE and NOTICE, and
  `package.json` and both plugin manifests declare the licence.
  `scripts/check-licences.ts` in the gates keeps NOTICE complete and the
  plugin's copies identical. Outside contributions sign off under the
  Developer Certificate of Origin.
- [CONTRIBUTING.md](CONTRIBUTING.md): how a change to Jig is made: one
  cohesive pull request per piece of work, the parallel-workspace rules, the
  pull-request lifecycle, the toolchain, the gates and the ratchet, local
  hooks, the derived files with their regenerate commands and drift checks,
  and keeping the auditor current.
- [docs/README.md](docs/README.md): Jig's own documents: their kinds, how
  each changes, which one wins when two disagree, and how decision records
  change. [docs/dispositions.md](docs/dispositions.md) lists Jig's defaults,
  each with the condition that changes it.
- [docs/adr/](docs/adr/): Jig's first decision records: the Bun and
  TypeScript toolchain, the plugin as its directory shipped in versions, and
  a person merging every pull request.
- [design/README.md](design/README.md) maps Jig's delivery stages to M6,
  requires a fresh-context review of a design before it is built, and gives
  the skeleton a new design starts from.
- New repository checks in `bun run gates`: M7's PR-target safety lint over
  Jig's workflows (`scripts/check-workflow-safety.ts`); the paths the
  instruction files and CONTRIBUTING.md name in code spans exist
  (`scripts/check-instruction-paths.ts`); and the AI reviewer's high-risk
  paths match the change-area catalog (`scripts/review-risk.ts`).
- The change-area catalog's optional `reviewRisk: high` marks the areas whose
  paths `scripts/review-risk.ts --write` writes into `.config/ai-review.yaml`.
  New narrow areas carry those paths, and `module-reference` splits from
  `module-templates`.
- Local git hooks (`lefthook.yml`, lefthook pinned in `mise.toml`): a commit
  formats its staged files, a push runs `bun scripts/gates.ts --fast`.
- `.config/ai-review.yaml` states that every automated reviewer only
  comments, and the measured precision a reviewer must reach before it may
  block.
- GLOSSARY.md names the words to avoid: **Consumer repository** and
  **Issue** are defined, and terms with rival words carry an *Avoid* line.

### Changed

- `/jig:audit apply` takes several recommendations and groups them into as
  few pull requests as possible, one unless part of the work needs its own
  decision; it leaves the audit record's scores to the next audit.
- M7's PR-target safety lint reads each workflow as parsed YAML: checkout
  inputs in any letter case and only under `with:`, the trigger from the
  parsed `on:`, and any reference outside the base side counts as untrusted.
  A workflow that does not parse fails with exit 2.
- M2's referenced-paths check skips slash commands, quoted shell text and
  fenced code written with tildes or indented, and resolves a bare folder
  name against the folders git lists.
- `decide`'s worked example against Jig's own corpus expects the approved
  toolchain decision record as the precedent.
- The plugin test checks the vendored YAML parser's licence, and the
  freshness test checks M2's committed example index.
- `scripts/check-branch-protection.ts` checks Jig's branch policy: the
  `gates` check required, every review thread resolved before merging, no
  force-push or deletion. An approving review, administrator enforcement and
  an up-to-date branch are reported, not required, and remediation keeps them
  as they are. CONTRIBUTING.md states the policy; `main` now requires
  resolved threads.

## [0.18.1] - 2026-10-13

### Changed

- `/jig:audit`'s M0 criteria follow the module: `tool-deltas-are-pointers`
  observes an import of the universal file where the runtime supports one,
  and `per-directory-instructions` observes that nested files extend their
  parent rather than a closest-file-wins policy.
- `/jig:audit` observes the practices M9 and M10 now teach: M9's
  `memory-location-designated` looks for one authoritative work-state store
  and handoffs on the tracker item (a resumption file for the same
  worktree may stay in its scratch), and M10's
  `verification-separated-from-pr-gates` looks for suites placed per change
  only when a merge or the `verified` pointer waits for them.

## [0.18.0] - 2026-10-13

The groundwork for batching several small issues into one pull request
([design/work-batch.md](design/work-batch.md), [ROADMAP.md](ROADMAP.md) item
13). Nothing a consumer has configured stops working.

### Added

- The tracker interface reads candidate pools: `openIssues` (a team's open
  issues by label conditions, including "carries none of these"),
  `openChildren` (the team's open children of one of its issues) and
  `poolIssue`. Each issue comes with its priority, creation time, state and
  assignee ids, labels, whether it has open children, and which nested lists
  were truncated. The Linear adapter implements them, refuses an empty label
  condition, which would read every open issue, and fails a read whose
  priority or children page it cannot read.
- [design/work-batch.md](design/work-batch.md): the design of a `work-batch`
  skill, moved from a working repository that uses it.

### Changed

- The change-area catalog's tracker block is `tracker:` (`tracker.labels`,
  `tracker.flags`), no longer `linear:`, in
  [M3](modules/M3-change-area-catalog/README.md)'s specification, example
  and template. `drive-pr`'s fleet-health sensor reads `tracker.labels` and
  still reads the older `linear.labels`, so a catalog can be renamed at any
  time. In the fields the sensor reads (`paths`, `generated` and its
  sources, `labels`, and the `tracker:`/`linear:` blocks with their
  `labels`), a value
  that is present but not the expected shape, `null` included, is refused;
  only an omitted field reads as empty. Other catalog fields are not
  validated by the sensor.
- The Linear adapter's `getIssue` fails a response that leaves out the
  issue, instead of reporting the issue as missing.

## [0.17.0] - 2026-10-13

The audit learns from its first live re-audit of Jig: it gathers the facts a
profile suggestion needs, shows the trend across past records and the gaps no
recommendation covers, and warns when a session runs an older plugin than the
one installed.

### Added

- `config-fit.ts` reports profile facts (human contributors in the last 90
  days and year, CI files that name deploy, release or publish work,
  compliance documents) and a `suggested_profile` with its reasons, lightest
  first: Solo/Lite for one person and no such CI file, Team/Standard
  otherwise, Regulated/Strict never on its own. The starter configuration
  gains `review.repo_slug` and `pull_requests.stacking` where the repository
  host proves them: stacking only from open pull requests based on another
  open pull request's branch.
- `config-fit.ts` warns (`fact:newer-plugin-installed`) when a newer version
  of the plugin is installed beside the one running (a version folder whose
  manifest names it): a session keeps the version it started with, so an
  update reaches the next session.
- The audit sheet:
  - **Trend**: `report.ts render --prior <record> --history <record>…` shows
    each module's level across past records, each measured against today's
    criteria without those added after its plugin version (a changed pass
    bar is read as it is now).
  - **Uncovered gaps**: a criterion within the target that no recommendation
    names and no held decline covers is marked in the map and listed;
    `report.ts validate` warns about each.
  - **Profile signals**: the report source's `profile.signals` lists facts
    worth revisiting the profile for, shown beside the profile.
  - "Decided by a probe" only for a score the probe wrote (`probe: `
    evidence).
  - **Conditional targets**: the profile's conditional targets, and those of
    the profile it is heading to, are checkboxes beside the profile
    selector, copied as `profile_conditions`; `apply-feedback` sets them in
    the record.
  - **Flag a score**: any criterion's score can be marked wrong with a note,
    copied as `scores:`; `apply-feedback` prints it as a calibration note and
    never changes the score.
  - With a profile, "Since the last audit" counts and lists the criteria
    still open within the target apart from those beyond it.
  - **A guide inside the sheet**: what Jig and the audit are, the
    enforcement ladder, the modules, the profiles with each one's
    target per module, how the audit works and how to read the report. It
    opens as its own view from the top bar (`#guide`), and is the last
    section without a script and in print. A first audit opens with a
    welcome that points to it.
  - **Icons and explanations**: each criterion in the maturity map is an
    icon for its rung (Lucide icons, inlined with their ISC licence, no
    network request) with a popover giving the criterion, its score and
    where it stands against the profile; every module ID is one chip with a
    popover naming the module and what it solves.
  - "Since the last audit" is a table with colour-coded changes and count
    badges.

### Changed

- `record.ts apply-feedback` ranks the accepted work as the sheet's Start
  here does (leverage × effort, then a quick win, then the report's order),
  no longer configuration first and in adoption order.
- A module the plugin added after an earlier audit reads as incomplete at
  that audit, in the comparison and the trend, no longer as Strict.
- M3's `consumer-view-generated` criterion accepts a view derived from the
  catalog on every run, as CI area flags are, besides a committed copy with a
  freshness gate, as the module's reference already did.

## [0.16.1] - 2026-10-13

Faster tests and a CI that runs only what a pull request's changes need.
Nothing in a consumer's configuration or a skill's behaviour changes.

### Added

- Jig's own change-area catalog, `.config/change-areas.yaml`
  ([M3](modules/M3-change-area-catalog/README.md)), resolved by
  `scripts/change-areas.ts`. CI selects its jobs from it: the drive-pr suite
  runs when the drive-pr skill or something it depends on changed, and macOS
  and Windows run the gate set when anything outside documentation changed;
  Linux always runs the whole gate set, and a push to `main` runs everything.
  `bun run gates` fails when the catalog is malformed or a file belongs to no
  area. `.config/jig.yaml` names the catalog in `drive.change_areas_catalog`.

### Changed

- `bun run test` runs test files in parallel, one per processor core.
- The longest test files of `drive-pr` and `resolve-review-comments` are
  split into several shorter ones, so parallel runs and CI shards are no
  longer held up by one file.
- Fixed waits in the skills' scripts (final-CI polling, kill grace periods,
  lock heartbeats and waits, polling intervals) can be shortened through
  environment variables the test suites set; the production values are
  unchanged and a variable can only lower its wait. They are internal test
  settings, not configuration.

### Fixed

- The drive-pr test harness kept its own lock pacing out of the scripts it
  spawned, so those tests waited at the production lock interval.

## [0.16.0] - 2026-10-13

The audit's result becomes an **audit sheet**: a polished HTML report a team
reads, decides on and hands back to the agent. A repository declares the
profile it aims for, and the audit recommends toward that target and no
further.

### Added

- The audit sheet ([format](plugin/skills/audit/references/report-sheet.md)):
  `report.ts render` turns the report source an audit writes, the record and
  the configuration-fit report into one self-contained HTML file and the same
  report as Markdown. It opens with the summary and a maturity map against the
  target, then the moves that matter most, what changed since the last audit,
  the recommendations grouped as *now*, *as you grow* and *optional*, every
  criterion with how it was decided and its evidence, configuration fit with a
  starter configuration, drift, and what was examined and what could not be
  checked. Each recommendation can be accepted, taken in its lighter form,
  refined, declined with a reason and a revisit condition, or marked *this is
  wrong*; **Copy decisions** writes them as one block for the agent.
  `report.ts validate` and `extract` check a source and recover everything a
  sheet was rendered from.
- [`profiles.yaml`](plugin/skills/audit/profiles.yaml): each profile's
  target level per module, conditional targets (M12 when agents work in
  parallel workspaces, M3 when a change's implications stop being obvious)
  and the order to adopt modules in. The record gains `profile:` and
  `profile_conditions:`; `record.ts check` refuses an unknown profile or
  condition, and `record.ts summary` shows the target and the gap.
- Each module's criteria file states its `purpose` in one sentence.
- Proportion: the record's `heading_to` names the profile a project is
  growing toward, and a recommendation may name a `lighter` option. The audit
  recommends toward the declared profile and no further; without one it
  suggests the lightest profile the repository's facts support.
- `record.ts apply-feedback <file|-> --report <source.json|sheet.html>`
  records the decisions copied from the audit sheet: it refuses a block written for
  another repository, commit or report (and an option it does not know, and
  accepted or refined work on a criterion the record holds declined), adds
  each decline to the record's `declined` list, or renews the entry that
  already declines the same refs, with every comment in the file and every
  other key of the entry kept (two declines of the same refs in one block must
  agree; a kept key's value must be one JSON can hold, so a date in one is
  quoted), sets the
  profile when
  the team changed it, and prints the accepted and refined work in adoption
  order, after the report's drift, and each *this is wrong* as a calibration
  note.
- `config-fit.ts --draft` prints a starter `.config/jig.yaml` (or the
  additions to an existing one) from the values the repository implies, each
  with the evidence it came from, never a default (a review bot whose
  account type cannot be read is reported unchecked, not suggested); an addition to a section
  the file already has says to merge it there. `--json` carries it as
  `draft`. The configuration schema gains `default`.

### Changed

- **Breaking:** a key of a `declined` entry in `.config/jig-audit.yaml`
  beyond `refs`, `reason`, `revisit_when` and `revisit_after` is now kept, so
  its value must be text, a finite number, `true`, `false`, `null`, or a list
  or mapping of those, and no list or mapping may appear twice among one
  entry's kept keys (a YAML alias to one does that; an alias to text or a
  number is fine); every `record.ts` command refuses the record otherwise.
  Before updating, quote a date in such a key (`reviewed_on: "2026-10-01"`),
  replace an infinite number, and write out a repeated list or mapping.
- `/jig:audit` ends with the audit sheet instead of a report written from
  `references/report-template.md`, which is gone: the sheet's Markdown copy is
  the text form. The skill asks for the team's profile on a first audit and
  records the decisions pasted back from the sheet.

## [0.15.0] - 2026-10-12

The auditor becomes a plugin skill, `/jig:audit`, that a repository runs again
and again. Nothing in a consumer's configuration changes.

### Added

- `/jig:audit` ([audit skill](plugin/skills/audit/README.md)): checks the
  repository's `.config/jig.yaml` against the repository, scores every
  module's maturity criteria with file-path evidence, writes the result to
  `.config/jig-audit.yaml`, and on a re-run reports what was fixed, regressed,
  is still open or was added by Jig since, without repeating a recommendation
  the team declined until its revisit condition holds. Read-only unless asked
  to apply one recommendation, which opens one pull request through
  `do-item`'s pull-request policy. `/jig:audit portfolio` compares several
  repositories' records.
- `config-fit.ts`: unknown, refused, deprecated and mistyped fields, what the
  skills' own validation rejects, commands and paths that do not exist, an
  unknown integration branch, required checks that never ran on recent merged
  pull requests, missing pull-request labels, an unreachable tracker, declared
  values the repository contradicts (`stacking: none` with stacked pull
  requests open, a declared reviewer that reviews nothing), and settings the
  repository suggests (a gate command, a change-area catalog, reviewers, the
  issue-key prefix). A command is checked as a shell would run it: a line
  the shell refuses, every `make` target, a bare `yarn`, `pnpm` or `bun`
  script, a program file that is missing, not executable or not tracked; what
  runs after a `cd` or in another directory, through `env` or `exec` with an
  option, or on a line using shell syntax beyond plain words, quotes and
  `&&`, `||`, `;` and `|` (a line break, an escape, a comment, an expansion,
  a glob, a tilde, a redirection) is reported unchecked, unless that line is
  one the shell refuses anyway. Without
  forge access the forge questions are unchecked, never passing. A decline in
  the audit record never hides an error, nor, from `check-audit-fit.ts`, an
  unknown key. It judges the repository's file alone, never the user file
  or `JIG__*` variables of whoever runs it, and reports what those add on
  that machine.
- A machine-readable configuration schema,
  [`config-schema.yaml`](plugin/skills/audit/config-schema.yaml), listing every
  field with its type, readers, deprecation and whether only a repository may
  set it. Tests fail when it and
  [CONFIGURATION.md](plugin/CONFIGURATION.md) list different fields or
  readers, or when its value sets differ from the reading skills' own.
- Optional `probe`s on maturity criteria (a necessary condition a file search
  can rule out, which scores the criterion `absent` when it does not hold, and
  leaves it unchecked when a file was too large to search) and
  `since:` markers on criteria and configuration fields, so a re-audit tells
  what Jig added from what the repository lost.
- M1 criterion `existing-findings-ratcheted` (Strict): a rule that still has
  findings is ratcheted against the merge base and promoted at zero.
- Jig's own audit record, [`.config/jig-audit.yaml`](.config/jig-audit.yaml),
  and a [calibration run](plugin/skills/audit/calibration/2026-10-12-execa.md)
  of the skill against an external library.

### Changed

- The modules' maturity criteria moved from `modules/M<n>-<name>/maturity.yaml`
  to [`plugin/skills/audit/criteria/`](plugin/skills/audit/criteria/README.md),
  and the auditor's method, survey prompts, templates and calibration run from
  `audit/` into the skill; `audit/score-modules.ts` is now the skill's
  `score.ts`. Each module README links its criteria file.
## [0.14.0] - 2026-10-12

### Added

- **Configuration layers.** Below the repository's `.config/jig.yaml`, every
  skill now reads `~/.jig/jig.yaml` (`JIG_HOME` moves the folder) for a
  person's or a machine's own values, and above it `JIG__<SECTION>__<FIELD>`
  environment variables for one run. Sections merge field by field; other
  values replace. The user file refuses the fields that describe one
  repository (`gates.command`, `repository.base_branch`, `issue_tracker.team`,
  `review.repo_slug`, `review.repo_label`, `ci.required_checks`). A layer (a
  file, or the environment variables together) may not hold a `__proto__`
  key, a value that contains itself, or more than 10,000 values once its
  aliases are expanded. A user file
  alone does not make a repository adopted. `JIG_USER_LAYER=off` leaves the
  user file out, and the independent review sets it so that its policy comes
  from the base branch alone. See
  [configuration layers](plugin/CONFIGURATION.md#configuration-layers).
- `resolve-review-comments/scripts/jig-config.ts` prints every field set in
  any layer, its value and the file or variable that set it; a key that
  holds a dot is written in quotes.

### Changed

- Every skill reads its configuration through one shared reader. Errors about
  a field name the file or variable that set it, not always the repository's
  file. An empty `.config/jig.yaml` is read as no values instead of being
  refused.
- `github-actions`, `promote-memory`, `design-brief-builder` and `descar`
  have the agent read their values with `jig-config.ts` rather than from
  `.config/jig.yaml`, so the user file and the environment apply to them too.

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

[Unreleased]: https://github.com/docomply/jig/compare/v0.34.0...HEAD
[0.34.0]: https://github.com/docomply/jig/compare/v0.33.1...v0.34.0
[0.33.1]: https://github.com/docomply/jig/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/docomply/jig/compare/v0.32.1...v0.33.0
[0.32.1]: https://github.com/docomply/jig/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/docomply/jig/compare/v0.31.1...v0.32.0
[0.31.1]: https://github.com/docomply/jig/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/docomply/jig/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/docomply/jig/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/docomply/jig/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/docomply/jig/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/docomply/jig/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/docomply/jig/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/docomply/jig/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/docomply/jig/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/docomply/jig/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/docomply/jig/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/docomply/jig/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/docomply/jig/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/docomply/jig/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/docomply/jig/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/docomply/jig/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/docomply/jig/compare/v0.18.3...v0.19.0
[0.18.3]: https://github.com/docomply/jig/compare/v0.18.2...v0.18.3
[0.18.2]: https://github.com/docomply/jig/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/docomply/jig/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/docomply/jig/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/docomply/jig/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/docomply/jig/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/docomply/jig/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/docomply/jig/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/docomply/jig/compare/v0.13.0...v0.14.0
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
