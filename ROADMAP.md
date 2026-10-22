# Roadmap

What Jig plans to build, in priority order. Each item says what a team that
uses Jig will get; how it is built, and the work only Jig's own maintainers
need, is in [the plan](design/plan.md), under the same numbers.

This page lists open work only. When an item is finished it leaves this page,
and what changed is recorded in [CHANGELOG.md](CHANGELOG.md).

## Now

### 3. The kickoff family

A `kickoff` skill that starts a new repository from nothing: requirements,
architecture, an adversarial review of both, the repository and its
[scaffolding](GLOSSARY.md), implementation plans and the first tracker
issues. It replaces the fixed starter kit the
[greenfield guide](adoption/greenfield.md) uses today. With it come
`red-team`, which reviews a requirements or architecture document from
several hostile points of view in a fresh session; plan review inside
`review`; a `docs` skill that runs [M4](modules/M4-docs-governance/README.md)'s
documentation checks; and `upgrade-deps`, which makes grouped dependency
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
calls Linear directly with fixed label groups, and the drive assumes a git
remote named `origin`. They move into configuration.

### 12. More tracker adapters

Jira, and a plan file kept in the repository, beside Linear. The
[tracker interface](GLOSSARY.md) first gains attaching a file, the one
operation the skills need that the interface does not have yet.

### 15. M14 Testing strategy: the rest

[M14](modules/M14-testing-strategy/README.md) gains exception lists that prune
themselves: the tests-with-changes gate failing on an exemption that matches no
file, and a `fixed-delay:` token gate that fails on a token with no delay
beside it.

### 17. Corrected designs for the existing modules

Practices working repositories validated, added to the modules that exist:
watchdogs for what is deployed (M10, M11), an acceptance stage (M6), a skill
that runs M7's post-merge stage in any repository, and a generator for the
model roster (M0).

### 20. `code-stats`: test-runner configuration and audit evidence

The [code-stats skill](plugin/skills/code-stats/README.md) learns which
files are tests from the test runner's own configuration (jest, vitest,
pytest, Gradle, Maven), is checked against a recorded set of public
repositories in several languages, and gives
[`jig:audit`](plugin/skills/audit/README.md) measured evidence: the test to
code ratio, the generated share and the size of the agent scaffolding.

### 21. `changelog` skill: several artifacts, and the whole file checked

A repository that releases several things at their own versions, such as a
monorepo's packages, keeps a changelog and a version for each with the
[`changelog` skill](plugin/skills/changelog/README.md), as
[M16](modules/M16-releases-versions/README.md) asks; today the skill keeps
one per repository. The skill also checks the whole changelog against the
rules of its format, and gets workflow templates for CI providers other than
GitHub.

### 22. Merge conflicts, measured

Measured [conflict hotspots](GLOSSARY.md) become findings in the
[reflection store](plugin/skills/reflect/README.md), grouped by their cause,
so the existing review and escalation loop turns recurring conflicts into
changes to the repository.

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

## Later

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
- **Windows for `drive-pr` and `do-item`.** Both skills, and the skills
  they invoke, on native Windows: first under Claude Code with Git for
  Windows' Bash, then under PowerShell for Codex.
- **Drive loop follow-ups.** A drive's CI-repair round running `fix-ci`,
  through a `fix-ci` mode that stops before pushing so the drive does the
  push itself.
- **Gates and workspace infrastructure.** Locks shared across
  worktrees, remote gates, and a runnable form of
  [M12](modules/M12-parallel-agent-ergonomics/README.md)'s workspace
  lifecycle for runtimes other than Herdr.
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
