# Roadmap

What Jig plans to build, in priority order. Each item says what a team that
uses Jig will get; how it is built, and the work only Jig's own maintainers
need, is in [the plan](design/plan.md), under the same numbers.

This page lists open work only. When an item is finished it leaves this page,
and what changed is recorded in [CHANGELOG.md](CHANGELOG.md).

## Now

### 32. Driving any pull request from anywhere, with autonomy that fits the hour

The review drive already runs from any checkout, restarts itself, is taken
over through a ledger on the pull request when its driver dies or stops
making progress, and stops for a person only on a configured human decision
class, with the decision framed
([drive-pr](plugin/skills/drive-pr/README.md)). What is left: a repository
may raise how far an agent decides on its own during the hours nobody is
there to ask; every decision taken that way is recorded on the pull request
where a person can reverse it, and a morning report lists them. It ships
once a working repository has validated it. Before that, the policy that
bounds what an agent may decide is read from the pull request's base branch,
so a pull request cannot widen what its own drive may decide.

### 33. The dispatcher: a tick that starts the execution line's stages

A small program on the machine that runs the agent sessions starts each
stage of the execution line that should be running and is not: a session
that picks up an item assigned to the team's
[factory identity](GLOSSARY.md), a restart of a review drive stopped by a
usage limit (on another account) or by a question a person has answered,
and the follow-up after a merge. It runs every few minutes, reports what it
would start and why before it is allowed to start anything, caps the
sessions per subscription account, and reaches a person on their phone for
the decisions that are theirs. It never merges. Every finished session
leaves a row in an [outcome log](GLOSSARY.md) that one dashboard filters
by time, repository, stage, account and outcome; a session that falls
behind what its stage should achieve is reported as
[drifting](GLOSSARY.md), never corrected on its own; and the one prompt
it sends a session by itself is "continue", once a usage limit has reset.
Orca is its first session runtime
([ADR-0011](docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)),
with others through the same interface.

### 3. The kickoff family

A `kickoff` skill that starts a new repository from nothing: requirements,
architecture, an adversarial review of both, the repository and its
[scaffolding](GLOSSARY.md), implementation plans and the first tracker
issues. It replaces the fixed starter kit the
[greenfield guide](adoption/greenfield.md) uses today. With it come plan
review inside `review`; and `upgrade-deps`, which makes grouped dependency
upgrades an update bot cannot make alone and drives them to merge.

### 7. The Notion store, verified against Notion

The [Notion store](plugin/skills/reflect/README.md#notion-store) for
reflections passes its tests against a stand-in for Notion's API. This item
runs it against Notion itself and fixes what differs.

### 8. The audit experience: what is left

An audit at the end of a greenfield kickoff that checks the chosen
[profile](profiles/README.md) first and leaves out the modules outside it;
and the audit results a team marks as wrong reaching the
[reflection store](plugin/skills/reflect/README.md), so the audit learns
from them.

### 19. Herdr as the primary workspace runtime

[Herdr](https://herdr.dev) is the [workspace runtime](GLOSSARY.md) Jig's
tooling is built and tested for first
([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
Opening a tracker issue as a Herdr workspace, on the machine or on a remote
host, and M12's worktree lifecycle in Herdr are available
([the Herdr workspace tool](tools/herdr/README.md)); what remains is checking
the drive, pickup and review skills inside Herdr on macOS and Linux.

## Next

### 9. Delegated merge (`pull_requests.merge: auto-on-converged`)

An opt-in setting that lets a converged drive arm the forge's auto-merge for
the exact commit it certified, for a repository that chooses to delegate the
merge. The delegation is read only from places the pull request cannot
change, and withdrawing it withdraws an auto-merge already armed. Jig itself
keeps a person merging ([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)).

### 10. Values the skills still assume

A few values are still fixed in the skills rather than read from
[configuration](plugin/CONFIGURATION.md): the review skill's follow-up step
calls Linear directly with fixed label groups, so a repository on GitHub
Issues, the default tracker, cannot yet defer a review finding, and some
skills outside the delivery loop still assume a git remote named `origin`
where the rest read [`repository.remote`](plugin/CONFIGURATION.md#repository). They move
into configuration, and the follow-up step onto the tracker interface, so it
files on every tracker Jig supports.

### 12. More tracker adapters

Jira, and a plan file kept in the repository, beside Linear and GitHub
Issues. The [tracker interface](GLOSSARY.md) first gains attaching a file,
the one operation the skills need that the interface does not have yet, and
the workspace launcher learns to open GitHub issues.

### 17. Corrected designs for the existing modules

Practices working repositories validated, added to the modules that exist:
watchdogs for what is deployed (M10, M11), an acceptance stage (M6), a skill
that runs M7's post-merge stage in any repository, and a generator for the
model roster (M0).

### 20. `code-stats`: a reference set and audit evidence

The [code-stats skill](plugin/skills/code-stats/README.md) is checked
against a recorded set of public repositories in several languages, and gives
[`jig:audit`](plugin/skills/audit/README.md) measured evidence: the test to
code ratio, the generated share and the size of the agent scaffolding.

### 21. `changelog` skill: several artifacts

A repository that releases several things at their own versions, such as a
monorepo's packages, keeps a changelog and a version for each with the
[`changelog` skill](plugin/skills/changelog/README.md), as
[M16](modules/M16-releases-versions/README.md) asks; today the skill keeps
one per repository. The skill also gets workflow templates for CI providers
other than GitHub.

### 23. Seed review lenses

[`review`](plugin/skills/review/SKILL.md) gains a set of
[review lenses](GLOSSARY.md), each the review form of one rule a module
states: no swallowed failure ([M15](modules/M15-contracts-errors/README.md)),
a test for each changed behaviour ([M14](modules/M14-testing-strategy/README.md)),
comments that say what the code does now ([M4](modules/M4-docs-governance/README.md)),
and types that admit no invalid value (M15). Each runs only when the diff
gives it something to check, comments until measurement shows it may block,
and can be loaded by a repository's own automated reviewer.

### 24. Resource garbage collection for a developer machine

One command, `jig gc`, that reports and then reclaims what parallel agent
worktrees leave on a machine: fixture processes, scratch directories,
container volumes and images, merged branches and tool state. Every kind
follows one contract (something must prove the resource dead, age only
guards, report first, fail closed, a receipt per run); a repository enables
the kinds it mints with its own facts, a machine sets the schedule, and
[M12](modules/M12-parallel-agent-ergonomics/README.md) gains the practice.

### 25. Dependency-review feedback

Tools that review a pull request's dependency changes for supply-chain risk,
such as Socket, report in a check and a summary comment. The review loop
already counts a failing check of theirs in its CI verdict, like any other
check, but does not read their alerts. The loop will read their alerts as
findings with a severity, answer or fix them like any other finding, and show
their scores without acting on them. A failing check of such a tool will not
stop a pull request by itself, unless the repository requires that check; its
alerts will.

### 26. `init`: setting a repository up for Jig

One command in a fresh clone that derives the values the repository already
states (gate command, integration branch, reviewers, issue-key prefix,
catalog, changelog), asks only what it cannot derive, writes
`.config/jig.yaml` with the evidence beside each value, enables the plugin
for everyone who clones, and checks the result the way the audit will. The
audit stays the measurement; init is the setup, and the audit's remedy for a
fixable configuration finding.

### 27. Work types: depth by kind of work

An item's type (bug, feature, improvement, task, spike) derived from the
tracker's label taxonomy, its own issue type or a conventional title prefix,
and one table saying what each type changes: pre-scouts, test-first, review
tiers, the change note, batchability, autonomy. A type lightens the work
only where no flag label, catalog review or gate asks for more, and an item
whose type is unknown gets the deepest treatment.

### 28. `verify` and `debug`: evidence before claims, and a bounded debugging protocol

`verify` runs a check and keeps the proof: the command, the tree it ran
against, its exit code, the test counts from the runner's own report, and
the output's head and tail, so a pull request's "tests pass" points at a
record and a new test's failing run is recorded before its passing one.
`debug` works one failure whose cause is not obvious through a fixed
protocol: reproduce, attribute on a fresh base, narrow, write down each
hypothesis, fix, and stop after a stated budget with the ledger posted where
the work is tracked, instead of a fourth guess.

### 29. The spec a work item links

A work item names where its requirements and acceptance criteria live, in
its own body or in whatever spec framework the repository already uses, and
Jig resolves that reference read-only, through an adapter per layout, into
requirements, acceptance criteria and tasks with their ids. The implementing
agent and the reviewer get the list, and the pull request accounts for every
criterion: met with evidence, deferred to a filed item, or not applicable.
The delivery loop writes no spec and dictates no format; the tools that
write specs well are recommended beside the adapter that reads each.

### 30. Scanner findings block convergence

A static-analysis app that reports to the pull request as annotations rather
than review threads (SonarQube Cloud does) has its findings worked by the
review loop when a round runs, but a drive with only annotations can converge
without starting one. They will count as open work beside threads and summary
findings; a finding that stands can be recorded against the head so a later
head is checked again; and the tool's own dismissal is made where the tool
offers one.

### 31. Routing work to an agent, a model and an effort

Delegation already picks an agent from the issue's change areas, labels and
title, and `do-item` reports the model tier and effort the work's type, its
size and flag labels and the change areas' mandatory reviews call for, by
rules a repository declares with defaults it overrides. The agent still
runs on whichever model and effort the session was started with, whatever
the work. Routing will apply that route to the implementer, opt-in, with
the reason recorded on the pull request where the review loop's reports
join it to the outcome, and a person's choice always able to override it.
Until then, the workspace launcher's Orca provider hands the agent's start
to the person; its Herdr provider starts the configured agent.

## Later

- **Scheduled-failure reconciliation.** A reusable reconciler for
  [M11](modules/M11-process-observability/README.md)'s scheduled failures,
  on the tracker interface: one issue per cause, bounded recurrence comments
  with announced suppression, and automatic closure on confirmed recovery.

- **Jira store for reflections.** Reflections kept as Jira issues, for a team
  that tracks its work in Jira.
- **More skills.** `scaffolding-update`, which keeps agent instruction files
  in step with decisions and audits them
  ([M0](modules/M0-instruction-architecture/README.md)), and a review skill
  for SOLID design principles.
- **Tracker planning.** Epic planning and prioritisation as skills on the
  tracker interface.
- **A forge interface.** GitHub is the only forge the pull-request skills
  work with; an interface with GitHub behind it, then GitLab as the second
  ([what it covers](plugin/EXTENDING.md#forge-github)).
- **CI logs from other providers.** `fix-ci` downloads a failed run from
  GitHub Actions only (any CI's saved log already works with `--log`).
- **Windows for `drive-pr` and `do-item`.** Complete the authenticated
  pickup, draft pull request, drive round and stop acceptance run under
  Claude Code and Codex with PowerShell.
- **Drive loop follow-ups.** A drive's CI-repair round running `fix-ci`,
  through a `fix-ci` mode that stops before pushing so the drive does the
  push itself.
- **Gates and workspace infrastructure.** Locks shared across
  worktrees, remote gates, and a runnable form of
  [M12](modules/M12-parallel-agent-ergonomics/README.md)'s workspace
  lifecycle for runtimes other than Herdr and Orca.
- **Orca: what is left.** The [Orca workspace tool](tools/orca/README.md)
  opens and removes worktrees and the launcher opens issues in Orca, on a
  machine or on a paired Orca server. Still open: an agent's start recorded
  on the server rather than on the launching machine, so two machines never
  start it twice; reflection findings parked on a server's host before a
  removal, which today refuses while unsent ones are there; hooks on a
  server's host supervised as they are on a machine; the review and merge
  stages shown on Orca's workspace board, beside the pickup and pull
  request stages it shows today; the drive, pickup and
  review skills checked inside Orca worktrees on a server, as item 19 does
  for Herdr; and the tool and the launcher's Orca provider on Windows, where
  the tool's host steps (`sh`, `test`, `mkdir`) need the host's own shell
  first.
- **Change-area consumer lint.** The
  [change-areas skill](plugin/skills/change-areas/README.md) checks the path
  lists in agent rules, hook configuration and CI workflow triggers against
  the catalog, so a copy of an area's globs fails when it drifts.
- **The resolver in the delivery skills.** A repository with a change-area
  catalog and no validation-plan command gets its plan from the catalog in
  `drive-pr` and `fix-ci` too, as `review` already does for its mandatory
  reviews.
- **Bun's linter and formatter.** A linter reports code that breaks a rule;
  a formatter rewrites code into one consistent layout. Bun is adding its
  own, `bun lint` and `bun fmt`, which could replace Biome (one tool that
  does both, which Jig uses for its TypeScript and JSON). Evaluate them once
  they ship in a stable Bun release.
- **Standalone reference gates.** Reference gates a repository can copy one
  at a time.
- **Module gaps.** The items each module README lists as future.
