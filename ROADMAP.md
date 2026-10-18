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

### 5. A shared runtime kernel and diagnostics

The skills' scripts each solve the same problems by hand: retrying, clean-up
on exit, decoding what `gh` returns, and errors that keep their cause. This
item moves what is left onto one shared runtime.

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

[Herdr](https://herdr.dev) becomes the [workspace runtime](GLOSSARY.md)
Jig's tooling is built and tested for first
([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
The [launcher](tools/launcher/README.md) opens a tracker issue as a Herdr
worktree workspace with the agent started and given its prompt, on the
machine or on a remote host;
[M12](modules/M12-parallel-agent-ergonomics/README.md)'s worktree lifecycle
runs in Herdr workspaces, keeping a worktree's unsent reflection findings
before it is removed; and the drive, pickup and review skills are
checked inside Herdr on macOS and Linux.

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
[tracker interface](GLOSSARY.md) first gains the operations the skills still
reach Linear for directly: creating and searching issues, adding labels and
attaching files.

### 15. M14 Testing strategy: the rest

[M14](modules/M14-testing-strategy/README.md) gains exception lists that prune
themselves: the tests-with-changes gate failing on an exemption that matches no
file, and a `fixed-delay:` token gate that fails on a token with no delay
beside it.

### 17. Corrected designs for the existing modules

Practices working repositories validated, added to the modules that exist:
watchdogs for what is deployed (M10, M11), an acceptance stage (M6), a skill
that runs M7's post-merge stage in any repository, a generator for the model roster and instructions that keep working
in every agent tool (M0, M4, M5).

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

A report of where a repository's merges conflict, from its git history and
from each resolution [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md)
makes: which files, how often, why (a count, a list or a version every
change edits in one place, or two changes to the same lines), and the change
that removes each cause. [M12](modules/M12-parallel-agent-ergonomics/README.md)
gains the practice of measuring and removing
[conflict hotspots](GLOSSARY.md), and the audit scores it.

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
  lifecycle.
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
