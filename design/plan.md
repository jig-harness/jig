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
  The opinions M6 leaves out (personas, tiers, model routing) belong in the
  skill, not the module. M6's PRD and architecture templates move into the
  skill (`templates/`), moved and not copied, and M6's README links them there
  ([the module contract](../modules/AGENTS.md#the-module-contract)); the
  NOTICE entries move with them.
- **`red-team`**: adversarial review of a requirements or architecture
  document by persona (critical chief technology officer, security auditor, performance engineer,
  cost optimizer), in a fresh session; the runnable form of M6's per-stage
  adversarial review.
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

### 5. A shared runtime kernel and diagnostics

The plugin's scripts each solve the same problems by hand: decoding JSON
from `gh` and configuration files, retrying, releasing locks on a signal,
reading the clock. When one fails, the cause is often lost (an error turned
into a default answer, a child's error output discarded), and nothing
records how long anything took. The ratchet counts those patterns, and
`plugin/shared/` holds the guards, error helpers, clock and
logger that replace them; what is left moves the code onto them.

- **Burn-downs**, as code is touched: the 91 `exactOptionalPropertyTypes`
  errors; drive-pr's own copies of `proc.ts`, `cli.ts` and
  `gh-conditional.ts` beside the shared ones; the duplicated block in
  `fleet-health.ts`; fallow's complexity hotspots.

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
What is built so far was written for Conductor; this item makes Herdr the
runtime it is built and tested for. Done when:

- the [launcher](../tools/launcher/README.md) has a `herdr` provider: it opens
  the routed issue's repository as a worktree workspace
  (`herdr worktree create`), starts the agent in it (`herdr agent start`)
  and hands it the prompt (`herdr agent prompt`), on the machine or on a
  remote host, with its own tests; the launcher's other parts do not change,
  and any consumer repository's own Herdr launch commands are retired in the
  same rollout;
- [M12](../modules/M12-parallel-agent-ergonomics/mappings.md)'s worktree
  lifecycle runs in Herdr: the create hook from the `worktree.created`
  plugin event, in the created worktree; the remove hook from a wrapper
  around `herdr worktree remove` that parks before removing (the
  `worktree.removed` event fires once the checkout is gone, so it only
  notifies); checked against the Herdr row of its mappings;
- `drive-pr`, `do-item` and `review`'s reading of a delegated agent's output
  are run in a Herdr workspace on macOS and on Linux, and what differs is
  fixed or written down;
- [plugin/EXTENDING.md](../plugin/EXTENDING.md)'s support tables list Herdr
  wherever they list a workspace runtime.

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
  [tracker interface](../GLOSSARY.md);
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

Jira, and a plan file kept in the repository. Both wait on the open decisions
below. Before a second adapter works end to end, the
[tracker interface](../GLOSSARY.md) gains the operations skills now reach
through the Linear MCP tools or the `linear` command: creating an issue,
searching open issues, adding labels and attaching a file. The deferral step
(item 10), `decide`, `explain` and `do-item`'s instructions then use them,
and `do-item`'s parent-status reconciliation reads the interface's answers
instead of Linear's. [plugin/EXTENDING.md](../plugin/EXTENDING.md#issue-tracker)
lists what still assumes Linear.

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
  - a ledger of out-of-tree work that blocks promotion;
  - a registry of external preconditions;
  - one self-closing issue per cause of a scheduled failure.
- **M6 and M7**:
  - an acceptance stage;
  - plan claims checked against the code before building;
  - the execution-plan format the pickup skill reads;
  - a skill that runs the post-merge stage M7 states, for any repository (the
    stage and its criterion are in [M7](../modules/M7-pr-lifecycle-review/README.md));
  - a lifecycle map with a check that every named skill exists.
- **M0, M4 and M5**:
  - a reference generator for the model roster, when the working tool moves
    here;
  - instructions that keep working in every runtime;
  - deferred promises in documents that point at live tracker items;
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

Parallel pull requests put each other in conflict, and each conflict costs a
resolution and a CI run; nobody can say how many there are, in which files,
or why. [design/merge-conflicts.md](merge-conflicts.md) has how it works:

- **A report from history**: `resolve-conflicts` replays every merge commit
  with `git merge-tree`, reads the decisions its own `Conflicts resolved:`
  sections recorded, and lists the conflicted paths with a cause each
  (derived, structural, echo, version, sequence, tally, append, packed
  list, adjacent, overlap) and the
  change that removes it; the paths that keep conflicting are the
  [conflict hotspots](../GLOSSARY.md).
- **A live record**: `resolve-conflicts` keeps one event per resolved path
  instead of overwriting its snapshot, which covers the rebases,
  cherry-picks and reverts the replay cannot see.
- **The practice**: M11's `merge_conflict` event and metric, the figure on
  `drive-pr`'s cross-PR scoreboard, M12's practice and audit criterion, and
  hotspots as findings in the reflection store.
- **One file per roadmap item** follows only if the report shows the plan
  or the roadmap conflicting where items are added or removed side by side.

Done when the report run on Jig's history lists its conflicts by path and
cause with a remedy for each, a resolution by `resolve-conflicts` leaves its
events, and an audit scores M12's new criterion from the report.

## Later

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
- **Windows for `drive-pr` and `do-item`.** Both skills, and the skills
  they invoke, running on native Windows under Claude Code with Git for
  Windows' Bash first, and under PowerShell (Codex on Windows) later. Much
  of the code already handles Windows: a pass and its registered runners
  are stopped by captured process identities, the clone key is not a path,
  and the pass is
  spawned without a shell. Both suites run on Windows every night; the tests
  that need a step below skip there, and each skip names the step that lifts
  it (`skipsOnWindows` in
  [lib/test-helpers/windows-skip.ts](../lib/test-helpers/windows-skip.ts)).
  The steps land in this order, each as its own pull request:
  1. **State, locks and paths** (`file-system`). Renames retried while
     another process holds the target open, lock renames retried before
     reading as claimed, both sides of a worktree's identity normalised
     before hashing (a mismatch makes a live worktree look deleted),
     `drive.ts` started through `import.meta.main`, the pickup record's
     no-link guard kept where `O_NOFOLLOW` does not exist, and a clear error
     on a volume without hard links.
  2. **The skills under Git Bash** (`git-bash`). Every script command led by
     `bun`, the `ps`, `setsid` and `nohup` instructions replaced by the
     scripts' own commands, the pass command resolved through
     [`PATHEXT`](../GLOSSARY.md) (an npm-installed agent CLI is a `.cmd`),
     `fix-ci`'s setup command run under a POSIX shell, and the platform
     support stated in the skills' READMEs. Windows runs a `.cmd` or `.bat`
     file only through `cmd.exe`, which the process runner's shell-less
     `spawn` never starts, so the runner gains a launch path for them: a
     resolved `.cmd` started as `cmd.exe /d /s /c` with every argument
     quoted for `cmd.exe`'s own rules, tested with arguments holding
     spaces, quotes, `%` and `^`. Done when a pickup, a driven round and a
     stop work end to end on a Windows machine.
  3. **Job Objects** (optional): each pass in a
     Windows [Job Object](../GLOSSARY.md), for a kill no directly started
     descendant escapes and a sound check that the tree is gone; or a
     recorded decision that captured process identities are enough.
  4. **PowerShell** (`powershell`, later): the shell constructs in the
     skills' instructions (`$(…)`, heredocs, pipes into `grep` or `tail`,
     `test`, `mktemp`, and `review`'s file-set logic) moved into the scripts
     they feed, so the skills run under Codex on Windows without Git Bash.
- **Gates and workspace infrastructure.** Cross-worktree locks and
  test infrastructure, remote gates, and a runnable form of
  [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s workspace lifecycle.
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
