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

Keeps a repository's changelog as a practice, not an afterthought, for a
repository that opts in: the skill, its gate and the change-note requests
below act only where `.config/jig.yaml` has a `changelog:` section, and a
repository without one is never asked for a changelog. It works in either
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
  it reads Jig's two plugin manifests, checks that their versions agree and
  that the current one has a heading, and holds branches to M12's change
  notes. The skill's check
  detects the format, validates the rules above, and takes the current version
  from the repository rather than from fixed paths; Jig's `bun run
  gates` keeps calling it.
- **Release**: for Keep a Changelog, M12's change-notes release step
  ([reference/change-notes/](modules/M12-parallel-agent-ergonomics/reference/change-notes/README.md))
  already writes each pull request's note into the version's section or
  Unreleased, moves the version and the comparison links. The skill moves
  that step and its branch check into the plugin (self-contained, so they run
  from the plugin cache), takes the notes directory, the changelog, the
  version files (`package.json`, `pyproject.toml` and others, not only JSON),
  the released paths and the version placeholders from configuration, and
  adds the Common Changelog form.
- **How the release reaches the integration branch**, chosen per
  repository: a direct push by a GitHub App the branch's ruleset lets past
  its rules (Jig's own setup, ADR-0004), or a release pull request a person
  merges, which needs no such exception. A workflow template per CI
  provider, and a setup step that walks through the App, the ruleset and the
  environment holding the key.
- `do-item` and `drive-pr` ask for a change note when a pull request changes
  what users see, where the format keeps one per change.

The practice itself (a changelog per released artifact, mechanically
checked) belongs in a module; decide whether M10 (environments and deploy)
holds it or a new release module does. M12 keeps the part about parallel
work: one change note per pull request, written in after the merge.

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

### 7. The Notion store, run against Notion

The [Notion store](plugin/skills/reflect/README.md#notion-store) is built and
passes the conformance suite against a local fake of the Notion API. What
is left is the run against Notion itself, which needs an integration's
token: set `NOTION_TOKEN` and `JIG_NOTION_LIVE_PARENT` (a scratch page shared
with the integration) and run
`bun test plugin/skills/reflect/__tests__/notion-live.test.ts`, then fix
where the fake and Notion disagree, in both.

Done when that test passes, and a repository reflects into a database `init`
created using only `NOTION_TOKEN` and `reflection.notion.database`.

### 8. The audit experience: what is left

The audit sheet, the decisions round trip, profiles as targets, the trend
across past records and the starter configuration are in the
[audit skill](plugin/skills/audit/README.md).
What its [design](design/audit-experience.md) still holds:

- **Greenfield**: an audit run at the end of the kickoff's repository
  bootstrap leads with the profile check and leaves out modules outside the
  profile; the kickoff family (item 3) calls it.
- **Calibration into the reflection store**: each *this is wrong* decision
  becomes a finding about the `audit` skill in the
  [reflection store](plugin/skills/reflect/README.md).

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
  formats the drive already knows;
- fields named after Linear: the review-triage file's
  `severity_mapping.<severity>.linear_priority` and
  `fractal-metrics.ts --skip-linear`, renamed with the old names still read.

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
below. Before a second adapter works end to end, the
[tracker interface](GLOSSARY.md) gains the operations skills now reach
through the Linear MCP tools or the `linear` command: creating an issue,
searching open issues, adding labels and attaching a file. The deferral step
(item 10), `decide`, `explain` and `do-item`'s instructions then use them,
and `do-item`'s parent-status reconciliation reads the interface's answers
instead of Linear's. [plugin/EXTENDING.md](plugin/EXTENDING.md#issue-tracker)
lists what still assumes Linear.

### 13. Batching small issues into one pull request (`work-batch`)

A `work-batch` skill that groups several small, independent issues from one
area of the code into one pull request, with one commit for each, and drives
it once: review cost is paid per pull request, so batching closes small
issues faster than one pull request each. It moves from a working repository
that uses it today, with that repository's labels turned into configuration;
[design/work-batch.md](design/work-batch.md) has the procedure, the
configuration and the build order. The tracker reads it needs, the
tracker-neutral catalog key and the plugin's shared catalog reader are built.
Done when:

- `work-batch` is in the plugin with its tests, reading every label through
  configuration, and the working repository's copy is deleted;
- no setting can remove a solo-only flag that the hitl or manual-ops label
  roles or the catalog's `tracker.flags` supply;
- `do-item`'s batch check names `/jig:work-batch`;
- the audit skill's schema and fit check cover the `work_batch` section.

### 14. M13 Pipeline economy: the rest of the module

[M13](modules/M13-pipeline-economy/README.md) states honest signal,
selection, superseding, bounds, ordering and placement. Still to come:

- **The CI hold**, as a practice: a held head fails a required check rather
  than skipping it, and only results that started after the release count.
  drive-pr's `ci.hold_label` is its runnable side.
- **Caches.** Complete keys, one namespace, bounded retention, a reported hit
  rate, and a trust boundary.
- **Cost.** Runner sizing, one authoritative run of each check, and cost
  measured with conditions that reopen a decision.

Done when these are in the module with their criteria.

### 15. M14 Testing strategy: the rest

[M14](modules/M14-testing-strategy/README.md) states test tiers with budgets,
honest doubles, the injected clock, polling, predicates proven where they
execute, typed builders, tests with every change and coverage as a trend.
Still open:

- a check that a job which provisions a real dependency executed at least one
  test, so a suite that skipped itself cannot report success;
- exceptions that prune themselves: the tests-with-changes gate failing on an
  exemption that matches no file, and a `fixed-delay:` token gate that fails
  on a token with no delay beside it;
- stale-test triage on a freshly fetched base, which `fix-ci` then follows;
- tests that pin the dependency behaviour a workaround exists for, and a
  scheduled run of the suite on the language runtime's next release.

Done when the skip check is in M14's reference with its criterion, and the
rest of the work listed above is in the module.

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
  - model routing with family-alias pins and a generated roster;
  - instructions that keep working in every runtime;
  - deferred promises in documents that point at live tracker items;
  - an audit catalog;
  - files that change only with an approved decision record.

Done when each module states the practice with its mappings and criteria, and
a re-audit of Jig scores them.

### 18. The jig-harness.dev website

`website/` renders this repository's documents as a designed site (Astro, a
static Cloudflare Worker), open only through a private link while Jig is a
work in progress; [design/website.md](design/website.md) has how it
works and what is left. Done when:

- a gate checks the contrast of every text pair and every hover and focus
  state, in both themes;
- search works on a phone, and the plugin page shows one agent's steps at a
  time.

Opening the site to the public is a decision for a person, together with
the repository's own visibility.

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
- **A forge interface.** GitHub is the only forge: the skills that work on
  pull requests call `gh` directly. An interface on the tracker's model (pull
  requests, review threads, checks and required checks, labels and comments),
  with the GitHub implementation behind it, then GitLab as the second; build
  it when a team on another forge needs it. What it covers is in
  [plugin/EXTENDING.md](plugin/EXTENDING.md#forge-github).
- **CI logs from other providers.** `fix-ci` finds and downloads a failed run
  through GitHub Actions only (any CI's saved log already works with
  `--log`); a provider interface for those two steps.
- **Windows for `drive-pr` and `do-item`.** Finding and waiting on a pass's
  processes without `ps` and POSIX signals, `do-item`'s pickup record without
  owner-only file modes, and a Windows CI job for both suites.
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
