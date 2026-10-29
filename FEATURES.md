# What you get

The [modules](modules/README.md) state Jig's practices as rules that name no
tool. This page is the other view: what a team can run, install or copy from
Jig today, each with the practice it carries out and what is on the roadmap
for it. The [skills and commands](plugin/README.md) come from one plugin
installed once per machine; the [quality gates](GLOSSARY.md) (checks a change
must pass), templates and reference tools ship with their modules; your own
values (gate command, reviewers, issue-tracker team and labels) live in one
[configuration](plugin/CONFIGURATION.md) file the skills read when they run.

Everything here keeps a person on the decisions that matter: the intent, the
merge, promotion to production and any change agents propose to their own
rules ([FACTORY.md](FACTORY.md#what-stays-with-a-person)).

Each section below ends with the skills that run it, the modules that state
the practice, and, where it applies, what is still open on the
[roadmap](ROADMAP.md).

## An audit of where you stand

`/jig:audit` scores your repository against every module's criteria with
file-path evidence, compares the result with the last run, and renders one
self-contained HTML [audit sheet](GLOSSARY.md). Nothing is applied: a person
marks each recommendation on the sheet, copies the decisions as one block of
text and hands them to an agent. The run's record stays in the repository, so
the next audit reports what drifted. It also checks the repository's
configuration against the repository itself.

`/jig:code-stats` measures what the repository is made of: every tracked file
by area (product code, tests, tooling, agent scaffolding, build, database,
docs, ops), kind, language and module, with its lines of code, in the
terminal, as JSON or as an interactive HTML report. It needs no setup, says
how much it could not classify, and names the rule behind any file.

- **Skills:** [`audit`](plugin/skills/audit/README.md),
  [`code-stats`](plugin/skills/code-stats/README.md)
- **Practice:** every module's criteria, as
  [principle 6](principles/06-audit-first.md) asks
- **On the roadmap:** `code-stats` figures as audit evidence (item 20)

## A work item carried from pickup to merge

`file-issue` puts the work item on the issue tracker first: a body that
still holds once the code moves, labels from the repository's label taxonomy
that are checked before anything is written, and a search for a duplicate.
`do-item` picks up one work item from the issue tracker, implements it, opens a
pull request the way the repository's [pull-request policy](GLOSSARY.md)
says, and starts `drive-pr`, which runs the review rounds unattended until
the pull request reaches one named end state (converged, waiting on a person,
conflicting, …). Each round is a fresh agent process, so a long drive never
depends on one session surviving. Inside a round, `resolve-review-comments`
walks every unresolved thread to an explicit outcome and `resolve-conflicts`
settles a stopped merge or rebase so both sides' intent survives; when
continuous integration ([CI](GLOSSARY.md)) turns red, the drive runs a repair round of its own, within a budget. A person
merges. Outside a drive, `fix-ci` fixes a failed run from its log.
Before it delegates, `do-item` reports the [route](GLOSSARY.md) the
implementer would run on: the model tier and effort the item's type, flag
labels and size call for, from rules the repository keeps as data, with the
rule behind each part. `work-batch` carries several small items from one area of the code the same
way, in one pull request with one commit each, so their review is paid once.

- **Skills:** [`file-issue`](plugin/skills/file-issue/README.md),
  [`do-item`](plugin/skills/do-item/SKILL.md),
  [`work-batch`](plugin/skills/work-batch/README.md),
  [`drive-pr`](plugin/skills/drive-pr/README.md),
  [`resolve-review-comments`](plugin/skills/resolve-review-comments/README.md),
  [`fix-ci`](plugin/skills/fix-ci/SKILL.md),
  [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md)
- **Practice:** [M7](modules/M7-pr-lifecycle-review/),
  [M9](modules/M9-tasks-memory/)
- **On the roadmap:** a converged drive arming the merge it certified
  (roadmap item 9); the route applied to the implementer and recorded on the
  pull request (roadmap item 31); the drive's CI-repair round running
  `fix-ci` (Later)

## Review in tiers, with an arbiter for contested findings

`change-areas` resolves a change against the repository's
[change-area catalog](GLOSSARY.md): which areas it touches, and what that
owes — the CI jobs, the checks to run before a push, the mandatory reviews,
the tracker labels, the steps after a deploy — and checks the catalog
itself. `review` checks a diff, a plan or a pull request in tiers: pattern
checks, contract checks, then semantic review against the repository's
decision rules and the reviews the catalog makes mandatory. `github-actions` reviews
workflow changes for security, pinning, caching and the repository's own
conventions. When a finding is contested and the triage rubric cannot settle
it, the `review-arbiter` agent rules: fix now, reject, won't fix, defer, or
escalate to a person. It reads code and never edits.

- **Skills:** [`change-areas`](plugin/skills/change-areas/README.md),
  [`review`](plugin/skills/review/SKILL.md),
  [`github-actions`](plugin/skills/github-actions/SKILL.md),
  [`review-arbiter`](plugin/agents/review-arbiter.md)
- **Practice:** [M7](modules/M7-pr-lifecycle-review/),
  [M3](modules/M3-change-area-catalog/)
- **On the roadmap:** `drive-pr` and `fix-ci` taking their validation plan
  from the catalog when no plan command is configured, as `review` already
  does, and a lint that checks the path lists in agent rules, hooks and CI
  triggers against the catalog (Later)

## A learning loop built into the process

[Reflection](GLOSSARY.md) is a step in the process, not a meeting. At a
natural end (a converged drive, an addressed review, the end of a session,
before a worktree is removed) `reflect` reads what the session recorded
about the repository's scaffolding, merges duplicates, names each finding's
class and writes it to a store every repository shares. `review-reflections`
turns the stored findings into changes a person approves, and a class that
keeps recurring is escalated to one tracker issue instead of filed again.
`promote-memory` moves a lesson from an agent's private memory into a
reviewed, shared document. The stores stand behind one contract with a
conformance suite: a folder store, a Notion store whose database people
browse and filter, and a GitHub store that keeps the findings as issues of
one repository.
Around the skills, the [miss→lens flywheel](GLOSSARY.md) answers each
significant miss with an additive check, validated on a replayable fixture
before it may block anything.

- **Skills:** [`reflect`](plugin/skills/reflect/README.md),
  [`review-reflections`](plugin/skills/review-reflections/README.md),
  [`promote-memory`](plugin/skills/promote-memory/SKILL.md)
- **Practice:** [M8](modules/M8-learning-loop/),
  [M9](modules/M9-tasks-memory/)
- **On the roadmap:** a Jira store for reflections (Later)

## Decisions recorded, found again, and turned into checks

`adr` creates, updates and checks [decision records](GLOSSARY.md) and the
machine-readable rules derived from them, so a settled decision becomes
something a review can test rather than a document nobody reopens. `decide`
settles a technical dilemma by searching the repository's precedent first,
then ruling or escalating to a person with a cited decision sheet. `explain`
writes a cited, commit-dated explainer of how part of the system works
today, for a decision, a review or onboarding.

- **Skills:** [`adr`](plugin/skills/adr/SKILL.md),
  [`decide`](plugin/skills/decide/SKILL.md),
  [`explain`](plugin/skills/explain/SKILL.md)
- **Practice:** [M5](modules/M5-adr-practice/)

## Design and planning grounded in the repository

The feature pipeline runs from research through requirements and
architecture to a design loop and an [epic](GLOSSARY.md) of planned work
items, with a template for each stage
([PIPELINE.md](modules/M6-feature-delivery-pipeline/templates/PIPELINE.md)).
`red-team` reviews a requirements or architecture document adversarially:
personas, from a critical chief technology officer to a reader who knows no
engineering terms, each read it in fresh context and report the passage, the
risk and the question the author must answer, in one report.
`design-brief-builder` assembles the brief bundle for an external design
session from the repository's real schema and code, and audits it for
prescriptions before it leaves. `review` checks each stage's plan or document
against the repository's decisions.

- **Skills:** [`red-team`](plugin/skills/red-team/SKILL.md),
  [`design-brief-builder`](plugin/skills/design-brief-builder/SKILL.md),
  [`review`](plugin/skills/review/SKILL.md)
- **Practice:** [M6](modules/M6-feature-delivery-pipeline/)
- **On the roadmap:** the greenfield kickoff as skills (roadmap item 3); epic
  planning on the tracker (Later)

## Gates that ship with their tests, each on a named rung

Every rule names where it lives on the [enforcement ladder](GLOSSARY.md),
from a written convention to a check that blocks the merge, and the audit
scores exactly that. The modules ship reference gates with their own tests: a
[grep gate](GLOSSARY.md) that fails on a forbidden pattern, a
[ratchet](GLOSSARY.md) that tolerates the findings a codebase already has
and refuses new ones, a commit-message marker, and freshness checks for
anything derived from a source. Pipeline economy spends CI only where it
changes a merge decision, and the testing strategy sets tiers with budgets.

- **Practice:** [M1](modules/M1-gates-enforcement-ladder/),
  [M2](modules/M2-generated-artifact-freshness/),
  [M13](modules/M13-pipeline-economy/),
  [M14](modules/M14-testing-strategy/)

## Change notes, and a changelog nobody fights over

Each pull request whose change the people using the software would notice
adds a [change note](GLOSSARY.md): a small file of its own, never an edit to
the changelog or the version. After the merge, a release
step writes the notes into the changelog, moves the version to the largest
bump asked for and deletes the notes, and the release is tagged once its
commit passes its checks. Two pull requests
never edit the same lines, so merging one does not put the others in
conflict. The `changelog` skill turns this on in a repository whose own
configuration names its changelog file, in Keep a Changelog or Common
Changelog format, with the version read from a file or from tags; its
commands check a branch, show the next release and run the release step. A
GitHub Action and workflow template run them in CI, pushing the release
directly or as a release pull request a person merges, and a guided setup
walks through the GitHub App, the branch rules and the workflow. Jig's own
releases are made this way.

- **Skills:** [`changelog`](plugin/skills/changelog/README.md)
- **Practice:** [M12](modules/M12-parallel-agent-ergonomics/),
  [M16](modules/M16-releases-versions/)
- **On the roadmap:** a changelog and a version per released artifact in one
  repository, and a check of the whole file against its format's own rules
  (roadmap item 21)

## Workspaces for many agents on one machine

Several agents on one machine and one repository collide on ports, shared
resources and the files every pull request edits. The module gives each
workspace its own ports and locks, sets the worktree lifecycle, and nudges a
reflection before a worktree is removed. The [launcher](GLOSSARY.md) wires
an issue tracker's "open in coding agent" button to a workspace: it assigns
the issue, writes the whole issue to a file the agent reads, picks the
repository from the issue's label and opens the workspace through a
[provider](GLOSSARY.md). Herdr is the [workspace runtime](GLOSSARY.md) the
tooling targets first, on macOS, Linux and remote hosts: the
[Herdr workspace tool](tools/herdr/README.md) opens an issue's branch as a
worktree workspace with its agent started and its first prompt sent once,
reattaches instead of duplicating either, and runs the repository's
worktree create and remove hooks. Orca, the desktop and remote agent
environment, is supported the same way: the
[Orca workspace tool](tools/orca/README.md) opens an issue's branch as an
Orca worktree, in Orca on this machine or on a paired Orca server, named as
the repository names its branches, with the create hook run and the agent
started once. On a machine where
the plugin is installed, it needs no setup per workspace in Herdr, Orca,
Conductor or any tool that creates worktrees and starts sessions with your
agent configuration; a remote host, a container or an isolated configuration
directory needs its own install
([where it works](plugin/README.md#where-it-works)).

Agent sessions also leave worktrees, scratch directories and tool state
behind. The [`jig gc`](plugin/gc/README.md) command, shipped with the plugin,
reports what remains, checks whether it is still in use, and writes a
[collection receipt](GLOSSARY.md) for every run. A repository declares the
resource kinds and paths its tools create; a person confirms those bounds
when installing a machine's daily job, which supports launchd on macOS,
systemd user timers on Linux and cron where neither is available. Collecting
runs read the declaration from the recorded remote base branch and stay
within the confirmed bounds. Worktrees, scratch directories and tool state
are currently report-only, because collecting them requires coordination with
the tools that create and use them; old receipts can be collected while
keeping the latest report for each repository and kind.

- **Practice:** [M12](modules/M12-parallel-agent-ergonomics/)
- **On the roadmap:** the skills checked inside Herdr (roadmap item 19), a
  runnable form of the workspace lifecycle for other runtimes (Later), and
  coordinated resource collection followed by container, branch and
  registered-process collection (roadmap item 24)

## One configuration file, read in layers

A repository keeps its own values in `.config/jig.yaml`: its gate command,
reviewers, tracker team and labels, pull-request policy, change-area catalog.
Values are read in [layers](GLOSSARY.md) for the person, the repository and
the single run, every field is documented with its default and the skills
that read it, and the audit checks the configuration against the repository.
Bindings to a named tool stand behind an interface: the skills reach the
issue tracker through a small [tracker interface](GLOSSARY.md) with adapters
for Linear and GitHub Issues, so another tracker is a new adapter, not a
change to the skills. [EXTENDING.md](plugin/EXTENDING.md) lists every point where an
organization plugs in its own commands, skills, reviewers and stores.

- **Practice:** [M0](modules/M0-instruction-architecture/),
  [M9](modules/M9-tasks-memory/)
- **On the roadmap:** Jira and plan-file tracker adapters (roadmap item 12); the
  values the skills still assume (roadmap item 10)

## Documents that say what is true now

Instruction files are layered so a rule loads only where it applies, with a
glossary so parallel agents use one word for one thing. The docs tree is
governed: a schema, a generated index, and [de-scarring](GLOSSARY.md), which
`descar` performs by removing review traces, struck corrections and
superseded statements from a promoted page. `docs` checks the whole tree in
one pass (frontmatter, index, dates, scars and deferrals), flags drafts left
stale and lists the documents the project's type calls for and the tree
lacks; its gates run the same way in a repository's hooks and CI. `programmatic-execution` runs a
bulk read-only check (cross-references, links, a search across many files)
as one script whose findings are a compact list, instead of reading every
file into the conversation.

- **Skills:** [`docs`](plugin/skills/docs/README.md),
  [`descar`](plugin/skills/descar/SKILL.md),
  [`programmatic-execution`](plugin/skills/programmatic-execution/SKILL.md)
- **Practice:** [M0](modules/M0-instruction-architecture/),
  [M4](modules/M4-docs-governance/)

## Adopt one module at a time, sized by a profile

No module requires another's strictest level. Each has three
[maturity levels](GLOSSARY.md) defined by observable criteria, and a
[profile](GLOSSARY.md) says which modules a project needs at which level: a
few at Lite for a one-person project, most at Strict for regulated work. The
adoption guides give an order for an existing repository
([brownfield](adoption/brownfield.md)) and a new one
([greenfield](adoption/greenfield.md)), and a team graduates to the next
profile when its answer to the profile's question changes.

- **Practice:** every module, composed by [profiles](profiles/README.md), as
  [principle 2](principles/02-modular-profile-composed.md) asks
