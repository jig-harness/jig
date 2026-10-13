# Roadmap

What Jig still has to build, in priority order. A session picking up
Jig work starts here.

This page lists open work only. When an item is finished it leaves this page:
what changed is recorded in [CHANGELOG.md](CHANGELOG.md), and how things work
now is documented where they live (module READMEs, the
[plugin](plugin/README.md), [CONFIGURATION.md](plugin/CONFIGURATION.md)).
Background on how the module map came about is in
[principles/](principles/README.md) and [modules/](modules/README.md).

## Now

### 2. Skill assets live in the plugin

The plugin installs only `plugin/`, so a skill cannot read anything under
`modules/`. Templates and gates a skill uses move into the skill that uses
them (moved, not copied), and the module links to them there: one source,
nothing to keep in step, as the maturity criteria already do from the
[audit skill](plugin/skills/audit/criteria/README.md). This unblocks items 3
and 4, which need M6's templates and M4's gates. The module contract changes
in the same pull request: [modules/AGENTS.md](modules/AGENTS.md) requires
`templates/` and `reference/` in every module directory, so the contract
changes with the move, and each module links to the assets it no longer
holds. Moving the plugin to the repository root is not an option: the root
`package.json` would make each tool install the development dependencies on
every machine.

### 3. The kickoff family

The greenfield kickoff becomes a living skill instead of a frozen seed, with
the skills it calls, written by this repository's author and free of
third-party lineage. Each moves from its source (the author's personal skill
workspace, whose copies are deleted in the same rollout):

- **`kickoff`**: the project bootstrap (requirements, architecture,
  red team, synthesis, repository bootstrap, plan review, developer
  documentation, scaffolding, agent hierarchy, implementation plans, tracker).
  It replaces `seeds/project-kickoff/`, which is an older copy. M6's PRD and
  architecture templates and the kickoff's own are merged into one of each.
  The opinions M6 leaves out (personas, tiers, model routing) belong in the
  skill, not the module.
- **`red-team`**: adversarial review of a requirements or architecture
  document by persona (critical chief technology officer, security auditor, performance engineer,
  cost optimizer), in a fresh session; the runnable form of M6's per-stage
  adversarial review.
- **Plan review**, folded into `review`, which already accepts a plan
  document: dependencies and critical path, completeness, simplification and
  effort checks.
- **`docs`**: the runnable form of M4: runs the repository's frontmatter,
  index and scar checks, flags stale drafts, and plans missing documentation by
  project type. The repository's M4 schema wins over the source skill's own
  frontmatter rules.
- **`upgrade-deps`**: grouped, changelog-driven dependency upgrades (the
  majors an update bot cannot do alone), opened through `do-item`'s
  pull-request policy and driven by `drive-pr`; the runnable side of M1's
  pin-and-update rule.
- **`design-brief-builder`**: two copies have diverged; merge the source's
  `failure-modes`, `bundle-contract` and `creative-latitude` references into
  this one.

[adoption/greenfield.md](adoption/greenfield.md) then points at
`/jig:kickoff` instead of the seed.

### 4. `changelog` skill

Keeps a repository's changelog as a practice, not an afterthought, in either
common format, detected from the file or set in configuration:
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) (an
`Unreleased` section filled as changes merge; `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`) or
[Common Changelog](https://common-changelog.org/) (written at release time
from the history; `Changed`, `Added`, `Removed`, `Fixed`; every entry
imperative, one line, with references; breaking changes marked and listed
first; no `Unreleased`).

- **Draft** entries from the merged pull requests and commits since the last
  release: rewritten for a reader, noise removed, related changes merged,
  breaking changes marked with what a consumer must do.
- **Check**, against the rules of the detected format rather than a union of
  both: structure, category names and order, dates written year-month-day,
  link references, and release coverage. Each rule, its conditions and its
  exemptions are taken from the format's own specification, cited where the
  check enforces them, not restated here. Jig's own
  `scripts/check-changelog.ts` is the starting point, not the finished check:
  it reads Jig's two plugin manifests and checks only that their
  versions agree and that the current one has a heading. The skill's check
  detects the format, validates the rules above, and takes the current version
  from the repository rather than from fixed paths; Jig's `bun run
  gates` keeps calling it.
- **Release**: write the version's section (or move `Unreleased` into it),
  update the comparison links, and leave tagging to the release step.
- `do-item` and `drive-pr` ask for an entry when a pull request changes what
  users see, where the format keeps one per change.

The practice itself (a changelog per released artifact, mechanically
checked) belongs in a module; decide whether M10 (environments and deploy)
holds it or a new release module does.

### 5. A shared runtime kernel and diagnostics

The plugin's scripts each solve the same problems by hand: decoding JSON
from `gh` and configuration files, retrying, releasing locks on a signal,
reading the clock. When one fails, the cause is often lost (an error turned
into a default answer, a child's error output discarded), and nothing
records how long anything took. The ratchet now counts those patterns; this
item gives each a named replacement and then moves the code onto it.

- **Shared code and logging.** A `plugin/shared/` directory, beside
  `skills/` (both manifests already ship `assets/` there; check both tools'
  installs before merging), for code more than one skill uses. It starts
  with: type guards and `decodeJson(text, guard)`; an error helper that
  keeps the cause; an injectable clock; and a logger that writes to standard
  error at the level `JIG_LOG` sets (`JIG_LOG_FORMAT=text|json`). The shared
  modules other skills import today from `resolve-review-comments` move
  there. The command-line boundary prints the stack under `JIG_LOG=debug`.
  `run()` keeps the last few kilobytes of a failed child's error output. The
  driver log gets a timestamp and level per line and a size cap. The 11
  local record guards move onto the shared one, and that rule becomes an
  error.
- **The drive loop on the kernel, and traces.** Shared retry and polling,
  and one process-wide registry that releases resources (`using` and
  `DisposableStack`) on return, error and signal, newest first, replacing
  each lock's own signal handlers and `drive.ts`'s hand-ordered release.
  `JIG_TRACE=1` writes timed spans as JSON lines under
  `~/.local/state/jig/traces/` for every `gh` and `git` call, lock wait,
  poll and pass, carried to child processes through `TRACEPARENT` and
  reaped by `reap-state.ts`; records hold command names, exit codes and
  durations, never arguments' contents or output. Kept apart from the first
  step because it changes the drive loop's signal handling.
- **Burn-downs**, as code is touched: the 91 `exactOptionalPropertyTypes`
  errors; the copies of `proc.ts`, `cli.ts` and `gh-conditional.ts` that
  drive-pr and resolve-review-comments each keep; the duplicated block in
  `fleet-health.ts`; fallow's complexity hotspots.

### 6. Session reflection with a pluggable store

Turns the reflection cycle of [M8](modules/M8-learning-loop/README.md) into
two skills: `reflect` records what a session learned about the scaffolding,
and `review-reflections` turns what accumulated into changes a person approves.
Today the plugin only nudges toward "the repository's own `/reflect`". The
design is in [design/reflection.md](design/reflection.md); this item builds:

- the event log (findings and decisions, each with the session that wrote it:
  Jig version, skills, time, harness, model), and the state computed from it;
- the per-worktree journal that captures findings as they happen, and
  `reflect`, which merges them, names their classes, escalates a recurring
  class to one tracker issue, and contributes the rest to the store;
- `review-reflections`, with the merge check that makes a fix `implemented`;
- the store contract, its conformance suite, the filesystem store, and the
  `command` store for a store a repository or a person writes;
- the `reflection` configuration section, on only when some layer has it, and
  the drive, the review loop, `do-item` and M12's worktree removal asking for
  reflection only when it is on. A repository that relied on the nudge to run
  its own `/reflect` without a `reflection` section stops being nudged; the
  release notes say so;
- in M8: the invariant gains "reflection records are append-only, carry an
  id, and their state is computed"; `mappings.md` lists the stores; the module
  links the skills. The reflection trigger and its markdown inbox stay as the
  option for repositories without the plugin.

Done when two repositories reflect into one filesystem store, a review run in
each shows only its own findings, a review run in this repository shows the
findings about Jig's skills from both, and the conformance suite passes
against the filesystem store. The design then moves into the skills' READMEs
and M8.

### 7. Notion store for reflections

The [Notion store](design/reflection.md#notion-store): reflections in a Notion
database people browse and filter, from two settings (`NOTION_TOKEN` and
`reflection.notion.database`), with `init` creating the database. One page
per change; each event kept in the page as a JSON block that `list` reads, and
the properties recomputed from the events as a view. Built after item 6, on
its contract.

Done when the conformance suite passes against a local fake of the Notion API
and against a live scratch database, and a repository reflects into a
database `init` created using only the two settings.

### 8. The audit experience: what is left

The audit sheet, the decisions round trip, profiles as targets, the trend
across past records and the starter configuration are in the
[audit skill](plugin/skills/audit/README.md).
What its [design](design/audit-experience.md) still holds:

- **Greenfield**: an audit run at the end of the kickoff's repository
  bootstrap leads with the profile check and leaves out modules outside the
  profile; the kickoff family (item 3) calls it.
- **Calibration into the reflection store**: each *this is wrong* decision
  becomes a finding about the `audit` skill once the store exists (item 6).

Done when a kickoff run ends with the greenfield check and a *wrong*
decision reaches the reflection store.

## Next

### 9. Delegated merge (`pull_requests.merge: auto-on-converged`)

Lets a converged drive arm the forge's auto-merge for the exact head it
certified. It relaxes "a human merges", so the doctrine change is approved on
its own. Work in progress is on branch `feature/auto-merge-on-converged`;
before it opens as a pull request the design must guarantee that:

- the delegation and the merge method are read only from sources the pull
  request cannot change, fetched fresh at the moment of the decision, and the
  integration branch is resolved independently of the pull request's own
  `repository.base_branch`;
- revoking the delegation, or any condition that refuses it, withdraws an
  auto-merge an earlier run armed, whatever the policy then says;
- `drive.ts` leaves the decision to the helper instead of gating on the pull
  request's own copy of the policy;
- an armed auto-merge is bound to the certified head and cannot arm before the
  reviewers summoned by Ready have reported;
- the doctrine (M7 invariant, the human-in-the-loop registry's Merge row, the
  maturity criteria) changes in the same pull request, in the direction the
  decision picks.

### 10. Values the skills still assume

Move into configuration when a consumer needs them:

- the review skill's deferral step (`defer-batch.ts`) calls Linear directly,
  with fixed label groups, instead of going through the
  [tracker interface](GLOSSARY.md);
- the drive pushes to and fetches from a remote named `origin`;
- summary-finding severity is parsed only for the reviewers whose comment
  formats the drive already knows.

### 11. Jig's own Simplified Technical English linter

`decide`'s `ste-lint` is a faithful TypeScript translation of a third-party
Python linter, kept output-identical to it. Rewrite it as Jig's own
implementation of the same writing rules, free to deviate where Jig's
rules differ (for example by folding in the corrections its wrapper applies
today), and keep crediting the original
([Credits](plugin/RECOMMENDED-SKILLS.md#credits)). The parity record and the
golden files from the Python linter then retire with the translation.

### 12. More tracker adapters

Jira, and a plan file kept in the repository. Both wait on the open decisions
below.

### 13. Batching small issues into one pull request (`work-batch`)

A `work-batch` skill that groups several small, independent issues from one
area of the code into one pull request, with one commit for each, and drives
it once: review cost is paid per pull request, so batching closes small
issues faster than one pull request each. It moves from a working repository
that uses it today, with that repository's labels turned into configuration;
[design/work-batch.md](design/work-batch.md) has the procedure, the
configuration and the build order. The tracker reads it needs and the
tracker-neutral catalog key are built. Done when:

- one catalog reader in the plugin, shared by `drive-pr` and `work-batch`,
  matches paths to areas and reads each area's `tracker.labels` and
  `tracker.flags`;
- `work-batch` is in the plugin with its tests, reading every label through
  configuration, and the working repository's copy is deleted;
- no setting can remove a solo-only flag that the hitl or manual-ops label
  roles or the catalog's `tracker.flags` supply;
- `do-item`'s batch check names `/jig:work-batch`;
- the audit skill's schema and fit check cover the `work_batch` section.

### 14. M13 Pipeline economy

A new module for the cost and speed of CI: spend CI only where it changes a
merge decision, and never let a saving turn a failure into a pass. M1 decides
what is checked; M13 decides how cheaply and quickly, without weakening it.

- **Honest signal.** Every required check reports on every head: selection
  happens inside the pipeline, behind one aggregator, never through trigger
  path filters.
- **The CI hold**, as a practice: a held head fails a required check rather
  than skipping it, and only results that started after the release count.
  drive-pr's `ci.hold_label` is its runnable side.
- **Selection.** One resolver job per run, and gates selected by their own
  subject, failing closed.
- **Supersede and bound.** Concurrency keys that drop only covered runs,
  timeouts on every job, and a bound on time spent waiting for a runner.
- **Placement.** Per change, after merge, on a schedule or on demand.
- **Caches.** Complete keys, one namespace, bounded retention, a reported hit
  rate, and a trust boundary.
- **Cost.** Runner sizing, one authoritative run of each check, and cost
  measured with conditions that reopen a decision.
- **Enforcement.** A workflow-convention lint as the reference gate.

Done when the module, its criteria and the lint are in, and Jig's own workflows
pass the lint.

### 15. M14 Testing strategy

No module states how to test yet. A new one covers:

- test tiers with triggers and time budgets, with a slow end-to-end sweep run
  per change only when a merge or the `verified` pointer must wait for it;
- a check that a job which provisions a real dependency executed at least one
  test;
- test doubles that reject what the real dependency rejects;
- an injected clock, and polling with a deadline instead of fixed sleeps;
- predicates proven where they execute;
- stale-test triage on a freshly fetched base, which `fix-ci` then follows;
- coverage published as a trend rather than used as a per-change gate;
- behaviour pins for dependency workarounds, and a canary on the next
  runtime release.

Done when the module, its criteria and the skip check are in.

### 16. M15 Contracts and error handling

A new module for the failures and interfaces that callers and stored data
depend on:

- never swallow an error, and keep its cause (Jig's own lint rules for this
  move into the module as its reference);
- typed failure channels, and branching on code or type rather than message
  text;
- one boundary that maps errors to responses;
- a registry of error codes as the single source, with every copy generated;
- migrations that are immutable once applied, with ledger integrity;
- a published interface that is internal by default.

Done when the module, its criteria and the migration gate are in.

### 17. Corrected designs for the existing modules

Practices a working repository validated, for modules that exist today:

- **M1**:
  - a gate reports passed, found violations, or could not decide, and never
    passes on input it could not read;
  - rules for writing gates that read documents;
  - findings that name the rule, the place and the remedy;
  - exceptions that fail once they suppress nothing;
  - supply chain beyond action pins (release cooldown, install-script
    allowlist, layered secret scanning);
  - agent-runtime hooks as a rung of the ladder.
- **M2**:
  - a declared inventory of generated files with one generic check runner;
  - regeneration after merge through a pull request;
  - a check that each generator reaches every input;
  - which numbers in prose may stay.
- **M10 and M11**:
  - the verified-pointer watchdog decides by cause and catches stalls in the
    runner queue;
  - the commit the gates passed is the commit shipped;
  - a ledger of out-of-tree work that blocks promotion;
  - a registry of external preconditions;
  - a heartbeat in which a stopped schedule reads as red;
  - one self-closing issue per cause of a scheduled failure.
- **M6 and M7**:
  - an acceptance stage;
  - plan claims checked against the code before building;
  - the execution-plan format the pickup skill reads;
  - a post-merge stage;
  - a lifecycle map with a check that every named skill exists.
- **M0, M4, M5 and M8**:
  - always-loaded context as a budget for each consuming runtime;
  - model routing with family-alias pins and a generated roster;
  - instructions that keep working in every runtime;
  - the M4 items listed as future that have been validated;
  - deferred promises in documents that point at live tracker items;
  - an audit catalog;
  - files that change only with an approved decision record.

Done when each module states the practice with its mappings and criteria, and
a re-audit of Jig scores them.

## Later

- **Jira store for reflections.** One issue per finding, of a custom issue
  type with fields for class, severity, target, harness, model and Jig
  version; the event kept as an issue property. Its shape and open questions
  are in [design/reflection.md](design/reflection.md#jira-store-future); build
  it when a team that tracks its work in Jira needs it.
- **More skills.** `scaffolding-update` (keeps agent instruction files in step
  with decisions and audits them; M0), with its paths as configuration; and a
  SOLID-principles review skill, once its generic procedure is separated from
  the stack-specific checks it carries.
- **Tracker planning.** Epic planning and prioritisation as skills on the
  tracker interface, where the procedure is generic rather than one
  organization's workflow.
- **More launcher providers.** A Herdr provider for
  [tools/launcher/](tools/launcher/README.md), once its generic workspace
  commands are separated from the product-specific setup they come with.
- **Gates and workspace infrastructure.** The change-area resolver
  ([M3](modules/M3-change-area-catalog/README.md)), cross-worktree locks and
  test infrastructure, remote gates, and a runnable form of
  [M12](modules/M12-parallel-agent-ergonomics/README.md)'s workspace lifecycle.
- **Shared test helper.** A shell-command reachability model for testing
  workflow files, once it is separated from the workflow conventions it is
  written against.
- **Module gaps.** Items each module README lists as future: M4's tag-merge
  normalizer and scheduled wiki lint, M3's catalog-to-regex reverse check
  (needs the resolver), a semantic tier for ADR rules (M5 with M7/M8), M12's
  probe-for-free port fallback.
- **Module consistency.** M6's stage gates require `status: accepted`, which
  M4's frontmatter schema does not define (it has `approved`), and M6's
  templates lack M4's required fields: pick one vocabulary. M3's two reference READMEs are correct but long and
  hedged; rewrite them to state the rules plainly.
- **Drive loop follow-ups.**
  - `drive-pr`'s CI-repair round should run `/jig:fix-ci`, but that
    skill commits and pushes on its own, while a drive pass must push through
    `finish-round.ts`; give `fix-ci` a mode that stops before pushing.
  - The orphan warning in `scripts/lib/state/orphans.ts` can never fire under
    the default state directory; remove it or make it look in the right
    place.
  - `references/post-fence.md` says its fence probe can go once every install
    of `resolve-review-comments` also carries `drive-pr`. The plugin ships both
    together; decide whether standalone copies still need the probe.
  - The refocus behaviour is enabled on half of `do-item`'s items as a
    comparison. Decide from its results whether it stays, becomes the
    default, or goes.
- **Standalone reference gates.** The gates in M0–M2 and M6–M9 import the
  repository's `lib/`, so a reader cannot copy one alone. Either make them
  self-contained or ship `lib/` as a documented, versioned dependency.
- **De-scarring the plugin's code comments.** About 300 comments in 59 files
  still say "an earlier change" where they should state the rule directly,
  and some tests still use bare `TASK` placeholders where an issue key was
  removed; rewrite them as their files are next touched, or in one sweep.

## Standing: backflow

Jig keeps learning from the repositories that use it. When one of them
finds a better gate, a corrected design or a new review lens, evaluate it for
Jig and port the corrected design, not the first attempt
([principle 5](principles/05-learning-loop.md)). A consumer's own values stay
in that consumer's configuration.

## Open decisions

These need a human decision before the work that depends on them starts.

- **Publishing.** Jig is private, under the Apache-2.0 licence with MIT-0
  templates; whether and when to open the repository, whole or per module,
  is still a human decision.
- **Plan-file tracker format**: one file for the whole plan, or one per item.
- **Optional tracker operations**: whether the tracker interface's reporting
  operations may be optional for an adapter that cannot answer them.
- **Resilience copies of critical rules**: whether a tool-specific instruction
  file may keep a checked copy of a few named critical rules, so they still
  bind when its import of the universal file is missing, or whether M0's
  "duplicate nothing" criterion stands and only asks for the import.
