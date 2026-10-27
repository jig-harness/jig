# The plan

Jig's open work in priority order, in the detail the people building it
need: what each item builds, what it waits on, and when it is done. The
public [roadmap](../ROADMAP.md) carries the same items under the same
numbers, a few sentences each, for teams that use Jig; an item only Jig's
maintainers need (an internal refactor, Jig's own tooling) is on this page
alone. `bun run gates` checks that every roadmap item is here, in the same
group and order. A session picking up Jig work starts here.

This page lists open work only. When an item is finished it leaves this page,
and the roadmap when it is listed there, in the same pull request: what changed is recorded in
[CHANGELOG.md](../CHANGELOG.md), and how things work now is documented where
they live (module READMEs, the [plugin](../plugin/README.md),
[CONFIGURATION.md](../plugin/CONFIGURATION.md)). Items too large to describe
here have a design in this folder ([README.md](README.md)).

## Now

### 3. The kickoff family

The greenfield kickoff becomes a living skill instead of a frozen seed, with
the skills it calls, written for Jig and free of third-party lineage. Each
moves in from where it is kept today, and that copy is deleted in the same
rollout:

- **`kickoff`**: the project bootstrap (requirements, architecture,
  red team, synthesis, repository bootstrap, plan review, developer
  documentation, scaffolding, agent hierarchy, implementation plans, tracker).
  It replaces `seeds/project-kickoff/`, which is an older copy. M6's PRD and
  architecture templates and the kickoff's own are merged into one of each.
  The opinions M6 leaves out (tiers, model routing) belong in the skill, not
  the module; its red-team phase runs
  [`red-team`](../plugin/skills/red-team/SKILL.md), which holds the
  personas. M6's PRD and architecture templates move into the
  skill (`templates/`), moved and not copied, and M6's README links them there
  ([the module contract](../modules/AGENTS.md#the-module-contract)); the
  NOTICE entries move with them.
- **Plan review**, folded into `review`, which already accepts a plan
  document: dependencies and critical path, completeness, simplification and
  effort checks.
- **`docs`**: the runnable form of M4: runs the repository's frontmatter,
  index and scar checks, flags stale drafts, and plans missing documentation by
  project type. M4's gates (`modules/M4-docs-governance/reference/`) and their
  self-tests move into the skill's `scripts/` and `__tests__/`, moved and not
  copied, and M4's README links them there. The repository's M4 schema wins
  over the source skill's own frontmatter rules.
- **`upgrade-deps`**: grouped, changelog-driven dependency upgrades (the
  majors an update bot cannot do alone), opened through `do-item`'s
  pull-request policy and driven by `drive-pr`; the runnable side of M1's
  pin-and-update rule.
- **`design-brief-builder`**: two copies have diverged; merge the source's
  `failure-modes`, `bundle-contract` and `creative-latitude` references into
  this one.

[adoption/greenfield.md](../adoption/greenfield.md) then points at
`/jig:kickoff` instead of the seed.

### 7. The Notion store, run against Notion

The [Notion store](../plugin/skills/reflect/README.md#notion-store) is built and
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
[audit skill](../plugin/skills/audit/README.md).
What its [design](audit-experience.md) still holds:

- **Greenfield**: an audit run at the end of the kickoff's repository
  bootstrap leads with the profile check and leaves out modules outside the
  profile; the kickoff family (item 3) calls it.
- **Calibration into the reflection store**: each *this is wrong* decision
  becomes a finding about the `audit` skill in the
  [reflection store](../plugin/skills/reflect/README.md).

Done when a kickoff run ends with the greenfield check and a *wrong*
decision reaches the reflection store.

### 19. Herdr as the primary workspace runtime

[Herdr](https://herdr.dev) is the workspace runtime Jig's tooling targets
first ([ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
The [Herdr workspace tool](../tools/herdr/README.md), the launcher's `herdr`
provider and M12's worktree lifecycle in Herdr are in place. Done when:

- each consumer repository's own Herdr launch and worktree commands call the
  workspace tool, and their copies of what it does are deleted, keeping only
  the repository's own setup as its `.config/worktree-hooks/create`;
- `drive-pr`, `do-item` and `review`'s reading of a delegated agent's output
  are run in a Herdr workspace on macOS and on Linux, and what differs is
  fixed or written down.

## Next

### 9. Delegated merge (`pull_requests.merge: auto-on-converged`)

Lets a converged drive arm the forge's auto-merge for the exact head it
certified. It relaxes "a human merges", so the doctrine change is approved on
its own. Before it ships, the design must guarantee that:

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
  [tracker interface](../GLOSSARY.md), so a repository on GitHub Issues,
  the default tracker, cannot defer a finding. Moving it onto the interface makes it work on
  every adapter; revisit for GitHub Issues what the step relies on that
  GitHub lacks or spells differently: label groups (GitHub labels have none,
  so the type and repository groups become configured label lists), its
  `--originating` and `--team` keys (validated through the adapter's key
  shape, `keys.ts`), the conditional description edits that keep concurrent
  deferrals from losing an entry (the interface may need a compare-and-set
  update, or a comment per entry where the tracker cannot compare), and
  GitHub's secondary rate limit on writes when a review defers many
  findings at once. Done when a deferral round files and appends its
  findings on both adapters, with the fake-tracker tests both adapters'
  tests use;
- the drive pushes to and fetches from a remote named `origin`;
- the markers of Jig's own finding format (`ai-review-backlog`,
  `ai-review-round`, the leading `ai-review-*` comments) are fixed, and the
  summary-comment markers default to `<!-- ai-code-review -->` and
  `ai-reviewed-sha`: they become settings with neutral defaults, set to the
  current names first in the repositories whose reviewer writes them;
- fields named after Linear: the review-triage file's
  `severity_mapping.<severity>.linear_priority` and
  `fractal-metrics.ts --skip-linear`, renamed with the old names still read.

### 11. Jig's own Simplified Technical English linter

`decide`'s `ste-lint` is a faithful TypeScript translation of a third-party
Python linter, kept output-identical to it. Rewrite it as Jig's own
implementation of the same writing rules, free to deviate where Jig's
rules differ (for example by folding in the corrections its wrapper applies
today), and keep crediting the original
([Credits](../plugin/RECOMMENDED-SKILLS.md#credits)). The parity record and the
golden files from the Python linter then retire with the translation.

### 12. More tracker adapters

Jira, and a plan file kept in the repository, beside Linear and GitHub
Issues. Both wait on the open decisions below. For every adapter to work end
to end, the [tracker interface](../GLOSSARY.md) gains attaching a file,
which `decide` and `explain` now do through the Linear MCP tools or the
`linear` command. The deferral step (item 10), `decide`, `explain` and
`do-item`'s instructions then use the interface's operations, and
`do-item`'s parent-status reconciliation reads the interface's answers
instead of Linear's on its native path too. The workspace launcher and the
Herdr kickoff open Linear issues only: a GitHub key (`#123`) needs a
launcher tracker for GitHub Issues and the key's file name (`issue-123`)
where they name a cache file or a claim.
[plugin/EXTENDING.md](../plugin/EXTENDING.md#issue-tracker) lists what
still assumes Linear.

### 15. M14 Testing strategy: the rest

[M14](../modules/M14-testing-strategy/README.md) states test tiers with budgets,
honest doubles, the injected clock, polling, predicates proven where they
execute, typed builders, tests with every change, coverage as a trend, a skip
tripwire, stale-test triage, behaviour pins and a runtime canary. Still open:

- exceptions that prune themselves: the tests-with-changes gate failing on an
  exemption that matches no file, and a `fixed-delay:` token gate that fails
  on a token with no delay beside it.

Done when both gates are in M14's reference with their criteria.

### 17. Corrected designs for the existing modules

Practices a working repository validated, for modules that exist today:

- **M10 and M11**:
  - a ledger of out-of-tree work that blocks promotion.
- **M6 and M7**:
  - an acceptance stage;
  - plan claims checked against the code before building;
  - the execution-plan format the pickup skill reads;
  - a skill that runs the post-merge stage M7 states, for any repository (the
    stage and its criterion are in [M7](../modules/M7-pr-lifecycle-review/README.md));
- **M0, M4 and M5**:
  - a reference generator for the model roster, when the working tool moves
    here;
  - files that change only with an approved decision record.

Done when each module states the practice with its mappings and criteria, and
a re-audit of Jig scores them.

### 18. The jig-harness.dev website

`website/` renders this repository's documents as a designed site (Astro, a
static Cloudflare Worker), open to every reader and to search engines;
[design/website.md](website.md) has
how it works and what is left. Done when:

- a gate checks the contrast of every text pair and every hover and focus
  state, in both themes;
- search works on a phone, and the plugin page shows one agent's steps at a
  time;
- the home and adoption pages show an audit sheet of Jig's own audit.

### 20. `code-stats`: test-runner configuration and audit evidence

The [code-stats skill](../plugin/skills/code-stats/README.md) classifies a
repository's files from conventions, attributes, its `code_stats`
configuration and a classify command. What is left:

- **Test-runner configuration** as the classification layer between
  built-in detection and `code_stats` (the seam is marked in
  `classify.ts`): jest and vitest `testMatch` and `include`, pytest
  `testpaths` and `python_files`, Gradle and Maven test source sets. Each
  reader states what it cannot read (a computed configuration) rather than
  guessing.
- **A reference set** of public repositories (a Python service, a Go
  module, a Rust workspace, a Java build, a JavaScript monorepo), each run
  recorded with its commit and its results beside it, as
  [the audit's calibration](../plugin/skills/audit/calibration/) is, so a
  change to a rule shows what it moves.
- **Audit evidence**: `jig:audit` reads `--json` (schema `code-stats/v1`)
  for the criteria that need a measure: the test-to-code ratio, the
  generated share, the scaffolding size, and a large unclassified share as a
  finding about the configuration.

Done when a repository whose tests only its test runner names is classified
correctly with no `code_stats` section, the reference set's recorded results
are checked by a test, and an audit sheet cites code-stats figures as
evidence.

### 21. `changelog` skill: several artifacts, and the whole file checked

The [`changelog` skill](../plugin/skills/changelog/README.md) is the
runnable form of [M16](../modules/M16-releases-versions/README.md) for a
repository with one released artifact. What is left:

- **Several released artifacts in one repository**, each with its own
  changelog, version, tag prefix and release paths: a `changelog` section
  that lists artifacts, a note's front matter naming the artifacts it
  reaches and the bump for each, a release run that releases each artifact
  whose notes wait as one version of that artifact, and tags that carry the
  artifact's name. A note reaching no artifact stays the repository's
  choice (Unreleased, or none). Done when a monorepo with two packages
  releases them independently through the action, and the single-artifact
  configuration keeps working unchanged.
- **A whole-changelog check**, against the rules of the detected format
  rather than a union of both: structure, category names and order, dates
  written year-month-day, link references, and release coverage. Each rule,
  its conditions and its exemptions are taken from the format's own
  specification, cited where the check enforces them. Of the whole file,
  Jig's own `scripts/check-changelog.ts` checks only that the version files
  agree and that the current version has a heading.
- **Other CI providers' templates** beside GitHub's workflow template, when
  a repository needs one.

### 22. Merge conflicts, measured

The replay, live record and [M11/M12 practice](merge-conflicts.md) measure
where parallel work conflicts and expose the result in the audit and
cross-PR scoreboard. What is left:

- **Into the learning loop**: turn conflict hotspots into findings in the
  reflection store, with each cause as the finding's class, so the existing
  review and escalation loop turns a recurring cause into a change.
- **One file per roadmap item** follows only if the report shows the plan
  or the roadmap conflicting where items are added or removed side by side.

Done when measured hotspots enter the existing reflection loop without a
second escalation path.

### 23. Seed review lenses

M7 says how [review lenses](../GLOSSARY.md) are held but ships none, so
nothing in `review` checks a change against the rules Jig's own modules
state. [design/review-lenses.md](review-lenses.md) has how it works:

- **The lens contract and the first lens**: one file per lens, selected by
  what the diff adds or removes, run by `review`'s semantic tier with fresh
  context, each finding carrying the evidence its lens asks for, and capped
  at a warning; `review.lenses` configuration; `jig.swallowed-failure` for
  M15.
- **`jig.test-gap`** for M14.
- **`jig.stale-comment`**, after M4 gains its rule for comments in code.
- **`jig.type-invariants`**, after M15 gains its rule for types.
- **Measurement and promotion**: a lens's findings on pull request threads
  counted into M8's parity report, one row per lens version, and a lens
  promoted to blocking only with the measurement that cleared the bar.

Done when `review` runs every seed lens a diff triggers and says why it
skipped the others, each seed lens's eval fixtures have passed live, and the
tallying script turns a fixture set of threads into one parity row per lens
version.

### 24. Resource garbage collection for a developer machine

A machine that runs many worktrees fills with what their sessions leave
behind (fixture processes, scratch directories, container volumes and images,
merged branches, tool state), each kind cleaned by its own script on its own
schedule or by nobody.
[design/resource-gc.md](resource-gc.md) has how it works: one runner, one
contract (a lifecycle predicate decides, age only guards, report first, fail
closed, a receipt per run), kinds a repository enables with its own facts,
and a machine layer for the schedule. What it will build, one pull request
per step:

- **Finish the first rollout**: move in the operated worktree reaper and its
  scheduler tests, with the creating/opening tool taking the shared session
  lock, and retire the working repository's copies in the same rollout.
  Coordinate tool-state creators with collection admission before enabling
  retirement; its legacy reaper lock excludes only other reapers.
  Validate its weekly job through the installed command before starting
  the later kinds. Worktree collection stays disabled until this integration.
- **Containers, volumes and images**, keyed to the compose projects the
  worktrees derive, and the machine-level dangling images and build cache.
- **Branches** merged as the forge records it (squash merges included) or
  into the base by ancestry, with the remote branch gone.
- **Processes**: the process registry as a shared module, the test runner
  registering its fixtures, and the kind reaping registered trees whose
  owner is gone.

Done when a working repository's weekly sweep is the installed `jig gc`
job, its own reapers and installers are gone, and the report names each
resource's proof before anything is collected.

### 25. Dependency-review feedback

A tool that reviews what a pull request does to the repository's
dependencies (Socket is one) reports through a check run and one summary
comment, and raises no review thread. The loop's CI verdict already counts
that check run like any other non-reviewer check (`ciVerdictOf` in
`plugin/skills/drive-pr/scripts/lib/status/evidence.ts`), so a failing one
reads as failing CI whether or not the repository requires it; what the loop
does not do is read the alerts as findings
([AI reviewers](../plugin/EXTENDING.md#ai-reviewers) says why). What it will
build, one pull request per step:

- **Read the report**: a dependency reporter is configured by its login and
  check name, and read by a format of its own, the way a
  [severity format](../plugin/EXTENDING.md#severity-formats) is: only from
  comments and checks that login posted. Socket is the first built-in, checked
  against its real comments and check runs.
- **Alerts become findings**: each alert the report carries is a finding that
  names the package and the alert, with its severity mapped onto `blocker`,
  `high`, `medium` and `low`. It enters the loop through the path summary
  comments already use, so the decline ladder and a top-level answer apply
  unchanged.
- **Scores stay advisory**: a report's scores (supply chain, quality,
  maintenance, license) appear in the drive's status and the pull-request
  plan, never as findings, with no threshold that turns a score into one.
- **A failing check does not block by itself**: the reporter's check run
  leaves the overall CI verdict, and only its alerts carry weight, as
  findings. A check the repository's effective CI policy requires (listed in
  `ci.required_checks`, or required by branch protection when that is unset)
  keeps that requirement.

Done when a drive on a pull request whose report carries an alert with a
severity answers it as a finding, a report with scores and no alert adds none,
and a failing reporter check with no alert does not hold the drive back,
unless the repository's effective CI policy requires that check.

### 26. `init`: setting a repository up for Jig

A repository adopts Jig by hand today: read the configuration reference,
write `.config/jig.yaml`, or copy the audit's starter configuration out of
the sheet. [design/init.md](init.md) has how it works: one detector shared
with the audit's configuration fit, a run that derives every value the
repository states, asks at most five questions for the rest, writes the
overlay with its evidence, enables the plugin for everyone who clones, and
checks the result the way the audit will; the audit measures, init writes.
What it will build, one pull request per step:

- **The shared detector**: `config-fit.ts`'s detection and draft move to
  `plugin/shared/detect.ts` with their tests, the audit unchanged.
- **The skill**: `plugin/skills/init/` with `init.ts` (derive, ask, write,
  check), refresh mode after a plugin release, tests from a plugin copy
  against fixture repositories with and without a configuration, the
  lifecycle-map row and the README table row.
- **The pointers**: the adoption pages, setup's next step, the audit's
  `remedy: init` marker and the sheet's command.
- **Project-level enablement** in the host settings files.

Done when a fresh clone with no configuration runs `/jig:init`, commits
what it wrote, the audit's configuration fit reports no finding about a
field init derived or wrote, every other finding is reported with its
remedy, and the brownfield and greenfield pages send a new repository
there first.

### 27. Work types: depth by kind of work

Every item runs the same stations at the same depth, and the kinds of work
Jig already knows (`labels.bug`, `batch_sizes`, `hitl`, the taxonomy's
closed `types` list) are read in scattered places or not at all.
[design/work-types.md](work-types.md) has how it works: the type derived
from the taxonomy's types family, the tracker's own type or a conventional
title prefix, never asked when derivable; one depth table per type with
defaults a repository overrides field by field; a type lowering depth only
where no flag, catalog review or gate raises it; an unknown type getting
the strictest value of every field. What it will build, one pull request per step:

- **The derivation**: `determine_type.ts`, `issue_tracker.types`, the
  defaults table as data with its tests, in CONFIGURATION.md; `do-item`
  prints the type and changes nothing yet.
- **`do-item` reads the row**: the pattern pre-scout, the review tiers and
  skip threshold, the change note, the body sections and the spike's `hitl`
  default move to the table, with a `task` fixture showing the lighter path.
- **`work-batch` and `file-issue`**: batchability from the row; the type
  written at filing.
- **The required check** that refuses a pull request whose item is
  of type `unknown` or links no item, reading its script and the type mapping from
  the base branch rather than the head, with a workflow template and the
  setup that makes it required.
- **The lifecycle map's column and M9's audit criterion.**

Done when a task-typed issue reaches its pull request with the depth its
row gives, a feature keeps every gate it has today, and the three former
conditions have no reader outside the table.

### 28. `verify` and `debug`: evidence before claims, and a bounded debugging protocol

A claim that the tests pass points at nothing, and a failure whose cause is
not named gets a fix, then another. [design/verify-and-debug.md](verify-and-debug.md)
has how it works: an evidence record tied to the tree hash, with the test
counts from the runner's report and an expected-failure mode for M14's
seen-to-fail; a `verify` skill that records and a pull-request policy that
refuses a push without a record; a `debug` skill that reproduces,
attributes on a fresh base, narrows, keeps a hypothesis ledger, fixes, and
stops after a budget with the ledger posted where the work is tracked.
What it will build, one pull request per step:

- **The record**: `shared/evidence.ts` with its tests, run from a plugin copy.
- **`verify`**: the skill, its README, the lifecycle row, the M14 link.
- **`do-item` and `fix-ci` record and require**: the policy refusal, the
  body's evidence section, the seen-to-fail requirement by work type (item 27).
- **`debug`**: the skill, the ledger, the budget, the hand-off from
  `fix-ci`, tests with a fixture whose failure needs attribution and one
  whose budget runs out.

Done when a pull request `do-item` opens carries an evidence section for
the pushed tree, `fix-ci` hands a surviving test failure to `debug`, and a
drive's repair round ends with a posted ledger when the budget runs out.

### 29. The spec a work item links

A work item carries or links its requirements, and the link is prose:
`do-item` hands the agent the body, the reviewer is told to check "the
acceptance criteria" wherever they are, and the pull request never says
which were met. [design/spec-link.md](spec-link.md) has how it works, on
the [spec ecosystems research note](spec-ecosystems-research.md): a
read-only resolver with one adapter per layout (the item's own body first,
then the common repository layouts by convention, then the tracker's
attachments once the interface has them) that returns requirements,
acceptance criteria and tasks with their ids; the result handed to the
implementing agent and the reviewer; a pull-request section accounting for
every criterion as met with an evidence record (item 28), deferred to a
filed item, or not applicable. The delivery loop writes no spec and
dictates no format.
What it will build, one pull request per step:

- **The resolver and the `body` adapter**, with the conformance test every
  adapter passes and the pull-request section; `do-item` prints the result
  and changes nothing else.
- **The repository adapters**, two or three layouts per pull request, each
  with its fixture folder; M6's audit criterion with the last of them.
- **`do-item` reads and requires**: the `spec` pre-scout by work type
  (item 27), the delegation prompt and the reviewer's list, the policy
  refusal for an unaccounted criterion, the recommended-skills page naming
  the spec-writing tools with the adapter that reads each.
- **The required check** that refuses an unlinked pull request or an
  unaccounted criterion, honouring an exception only when a member of
  `specs.exception_approvers` other than the author and the implementing
  agent's identity applied its label after the exception record `do-item` writes (the references, each source's revision and the exception lines) last changed, the record still matches, and the label is
  still on, reading its script and policy from the base branch rather than
  the head, with a workflow template and the setup that makes it required.
- **`review` in plan mode, `file-issue`, `/followup` and the epic close.**
- **The tracker source**, once the tracker interface has attachments
  (item 12).

Done when a feature whose body links a spec in any supported layout
reaches its pull request with every acceptance criterion accounted for,
one with none stops, saying so, before any code is written, and the stance (a work
item links its requirements; the delivery loop writes no spec) is a decision record.

### 30. Scanner findings block convergence

`resolve-review-comments` lists the findings a static-analysis app reports as
check-run annotations (`review.scanner_apps`), and `drive-pr` tells the agent
to work them, but the drive's verdict reads threads and summary comments
only, so a drive can still end `CONVERGED` over an annotation. What it will
build: the annotation listing as a third source of open work beside threads
and summary findings, read by `drive-status`, `round-plan` and `converge`,
so the verdict withholds `CONVERGED` while a scanner check is running on the
head or lists a finding no round has answered; a way to record a finding
that stands (rejected, won't fix, deferred) against the head so it stops
counting; and the dismissal in the tool for the apps that expose one
(SonarQube Cloud's issue transitions), as an adapter beside the listing.
Done when a pull request whose scanner check holds a warning does not
converge until a round fixes it or records why it stands.

### 31. Routing work to an agent, a model and an effort

`do-item` already chooses which agent implements an issue, from the
change-area catalog, the issue's labels and its title
(`determine_agent.ts`), but nothing chooses the model or the effort, and
nothing learns from how the work went. A bug fix in one file and an epic's
architecture spike get the same model; a person picks by hand, or the
workspace launcher starts its default. The launcher's Orca provider now
hands the start to the person by default, and starts an agent only where
its settings name one; the Herdr provider still starts `claude` unless its
settings name another ([tools/launcher](../tools/launcher/README.md)).
Routing is what would let the launcher, and `do-item`'s delegation, choose
the model and the effort too, building on the agent selection that exists
rather than replacing it. Open questions before a design:

- the inputs: the work type (item 27), size and the area's sensitivity flags
  from the change-area catalog, the repository's history of what each
  agent and model converged on, and what the machine and the subscription
  have left;
- where the decision is made: a router a capable model runs before pickup,
  or rules as data a repository overrides, with the reason recorded so it
  can be checked against how the work went (M11);
- the output every runtime can take: agent, model and effort for a launch
  (`orca agent launch --model --effort`), for `do-item`'s subagents and for
  a drive's passes, with the person's choice always able to override it.

Done when the design is written and decided; the build is its own epic.

## Later

- **Scheduled-failure reconciliation.** Move an operated reconciler onto the
  existing tracker interface, following the
  [design](scheduled-failure-reconciliation.md). M11 states the per-cause
  issue lifecycle and announced flood breaker; implementation remains open.
  Done when evidence-only tests feed separate triage, retries and overlapping
  runs preserve one issue per cause, and suppression and genuine recovery
  are verified in a consumer with the source copy retired.

- **Jira store for reflections.** One issue per finding, of a custom issue
  type with fields for class, severity, target, harness, model and Jig
  version; the event kept as an issue property. Its shape and open questions
  are in [design/reflection.md](reflection.md#jira-store-future); build
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
  [plugin/EXTENDING.md](../plugin/EXTENDING.md#forge-github).
- **CI logs from other providers.** `fix-ci` finds and downloads a failed run
  through GitHub Actions only (any CI's saved log already works with
  `--log`); a provider interface for those two steps.
- **Windows for `drive-pr` and `do-item`.** The remaining acceptance work is
  an **authenticated workflow**: run a real pickup, draft pull
  request, driven round and stop on Windows under Claude Code and under
  Codex with PowerShell. The deterministic smoke uses local fake services;
  it does not certify the agent and credential integration. Fix what the
  authenticated run finds, and remove the corresponding validation limits
  from the skills' READMEs. Cancellation uses captured process identities
  within the cooperative scope recorded in
  [ADR-0008](../docs/adr/ADR-0008-windows-cancellation-uses-captured-process-identities.md).
  **Fixture throughput** also remains: optimize the named multi-round,
  long-CI drive and large post-retirement census fixtures until they fit their
  existing native Windows test budgets, then lift their named skips.
- **Gates and workspace infrastructure.** Cross-worktree locks and
  test infrastructure, remote gates, and a runnable form of
  [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s workspace lifecycle
  for runtimes other than Herdr and Orca, which have one
  ([Herdr](../tools/herdr/README.md#the-worktree-hooks),
  [Orca](../tools/orca/README.md)).
- **Orca: what is left.** The [Orca workspace tool](../tools/orca/README.md)
  and the launcher's `orca` provider open an issue's branch as an Orca
  worktree, on a machine or on a paired Orca server, with the create hook
  run and the agent started once per issue. Still open:
  - the agent's start is recorded on the launching machine
    (`~/.jig/orca/kickoff/`), so two machines opening one issue on the same
    server each start an agent; record it on the server, as the Herdr tool
    does on its host, once Orca offers a place to keep it or the tool runs
    there;
  - `remove` parks reflection findings only when the clone is on this
    machine; on a server's host it reads the worktree's journal over SSH
    and refuses while unsent findings are in it, leaving the parking to a
    reflection run there. Run the journal there, as the Herdr tool runs on
    its host;
  - a hook on a server's host runs as one SSH command under the call's
    deadline, with nothing from Jig there to supervise it: a hook that
    outlives the deadline, or starts a child that outlives it, is left to
    the host, where on a machine the Herdr tool's supervisor ends the hook's
    whole process group. Supervise it there too, once what the host must
    provide is decided: `bun` for the shared supervisor, as the Herdr tool
    asks of its hosts, or a supervisor in the host's own shell;
  - `do-item` shows pickup and the opened pull request on Orca's
    workspace board (`plugin/skills/do-item/scripts/orca-board.ts`); the review and merge
    stages are not shown yet (`drive-pr` converged, the merge's follow-up
    moving the card to `completed`), and the tracker's GitHub issues could
    be linked with `--issue`;
  - a worktree created in the Orca app gets Orca's branch name and Orca's
    own setup hook, not the repository's convention and create hook; say in
    M12's mappings how a repository's `orca.yaml` setup script and Orca's
    branch-prefix setting approximate them, once validated in a consumer;
  - the drive, pickup and review skills checked inside Orca worktrees on a
    server, as item 19 does for Herdr;
  - the tool and the launcher's Orca provider on Windows: the tool drives
    its host with `sh`, `test` and `mkdir` and, on this machine, supervises
    its hooks through `/proc` or `ps`
    ([CONTRIBUTING.md § Toolchain](../CONTRIBUTING.md#toolchain) records
    the gap), so a Windows host needs those steps in its own shell first,
    and the provider tried there once it has them.
- **Change-area consumer lint.** The `lint-consumers` check moves into the
  [change-areas skill](../plugin/skills/change-areas/README.md): the path
  lists in agent rules, hook configuration and CI workflow triggers checked
  against the catalog, so a consumer that restates an area's globs fails when
  they drift ([M3](../modules/M3-change-area-catalog/README.md) lists it as
  future). Bring it in with its tests, and its consumer-specific path lists
  as the repository's configuration or composer.
- **The resolver in the delivery skills.** When a repository declares
  `drive.change_areas_catalog` and no `drive.validation_plan_command`,
  `drive-pr` and `fix-ci` take their validation plan from the change-areas
  resolver instead of `gates.command` alone, as `review` already does for
  its mandatory reviews. Done when a repository with only a catalog gets
  the catalog's plan in a drive round and in `fix-ci`, with a test for each.
- **Bun's linter and formatter.** A linter reports code that breaks a rule;
  a formatter rewrites code into one consistent layout. Jig uses Biome, a
  single tool that does both, for its TypeScript and JSON. Bun is adding its own:
  `bun lint`, which accepts the rules of ESLint and oxlint (two widely used
  JavaScript and TypeScript linters) including rules that use type
  information, and `bun fmt`, which formats as Prettier (a widely used
  formatter) does. They could replace Biome: one development dependency
  fewer, and rules that read the types in place of Biome's experimental
  ones. Evaluate them once they ship in a
  stable Bun release: port the rules in
  [tools/quality/grit/](../tools/quality/grit/) to ESLint rules with their
  fixtures; give the ratchet (`tools/quality/ratchet.jsonc`) a counter for
  `bun lint`'s report in place of its `biome-json` one, with fixtures showing
  it counts the same warnings Biome did, and teach it to read the `[lint]`
  section of `bunfig.toml` and count `eslint-disable` comments;
  map `biome.json`'s rule settings; keep Biome, or another linter that reads
  JSON, for the JSON files if `bun lint` still covers only JavaScript and
  TypeScript; decide whether Markdown and YAML are
  formatted, then run both linters side by side for one release before
  Biome goes. M1's and M14's `mappings.md` gain `bun lint` as a TypeScript
  option in the same pull request.
- **Shared test helper.** A shell-command reachability model for testing
  workflow files, once it is separated from the workflow conventions it is
  written against.
- **Module gaps.** Items each module README lists as future: M4's tag-merge
  normalizer and scheduled wiki lint, M3's catalog-to-regex reverse check
  (can be built on the change-areas skill's resolver), a semantic tier for
  ADR rules (M5 with M7/M8), M12's
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
- **History in the plugin's code comments.** Many comments in `drive-pr`
  and `resolve-review-comments` still tell how the code got its shape ("this
  fix", "an earlier version", "the old code") instead of stating the rule;
  rewrite them as their files are next touched, or in one sweep.

## Standing: backflow

Jig keeps learning from the repositories that use it. When one of them
finds a better gate, a corrected design or a new review lens, evaluate it for
Jig and port the corrected design, not the first attempt
([principle 5](../principles/05-learning-loop.md)). A consumer's own values stay
in that consumer's configuration.

## Open decisions

These need a human decision before the work that depends on them starts.

- **Plan-file tracker format**: one file for the whole plan, or one per item.
- **Optional tracker operations**: whether the tracker interface's reporting
  operations may be optional for an adapter that cannot answer them.
- **Resilience copies of critical rules**: whether a tool-specific instruction
  file may keep a checked copy of a few named critical rules, so they still
  bind when its import of the universal file is missing, or whether M0's
  "duplicate nothing" criterion stands and only asks for the import.
