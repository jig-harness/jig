# What you get

The [modules](modules/README.md) state Jig's practices as rules that name no
tool. This page is the other view: what a team can run, install or copy from
Jig, and the practice each one carries out. The
[skills and commands](plugin/README.md) come from one plugin, installed once
per machine. The [quality gates](GLOSSARY.md) (checks a change must pass),
templates and reference tools ship with their modules. A team's own values,
such as its gate command, reviewers and issue-tracker labels, live in one
[configuration](plugin/CONFIGURATION.md) file the skills read when they run.

Everything here keeps a person on the decisions that matter: the intent, the
merge, promotion to production and any change agents propose to their own
rules ([FACTORY.md](FACTORY.md#what-stays-with-a-person)).

Each section below opens with the problem it solves, as a team would say it.
It ends with the skills that run it, the modules that state the practice,
and, where it applies, what is open on the [roadmap](ROADMAP.md).

## An audit of where you stand

"Nobody can say how far we have come, or whether the rule we 'always follow'
still holds."

`/jig:audit` scores a repository against every module's criteria with
file-path evidence, and compares the result with the last run. It renders
one self-contained HTML [audit sheet](GLOSSARY.md). Nothing is applied: a
person marks each recommendation on the sheet, copies the decisions as one
block of text and hands them to an agent. The run's record stays in the
repository, so the next audit reports what drifted. It also checks the
repository's configuration against the repository itself.

`/jig:code-stats` measures what the repository is made of. It classifies every
tracked file by area, kind, language and module, and counts its lines of
code. The areas are product code, tests, tooling, agent scaffolding, build,
database, docs and ops. It reports in the terminal, as JSON or as an
interactive HTML report. It needs no setup, says how much it could not
classify, and names the rule behind any file.
Jig's own report is on the site, at [jig-harness.dev/stats/](https://jig-harness.dev/stats/).

- **Skills:** [`audit`](plugin/skills/audit/README.md),
  [`code-stats`](plugin/skills/code-stats/README.md)
- **Practice:** every module's criteria, as
  [principle 6](principles/06-audit-first.md) asks
- **On the roadmap:** `code-stats` figures as audit evidence (item 20); an
  audit that learns from the results a team marks as wrong (roadmap item 8)

## A work item carried from pickup to merge

"The review bot left forty comments and someone lost the afternoon to them."

An agent puts the work item on the issue tracker first. Its body holds once
the code moves, its labels are checked against the repository's own before
anything is written, and a search looks for a duplicate. An agent then takes
the item, builds it and opens a pull request the way the repository's
[pull-request policy](GLOSSARY.md) says. Before it hands the work to an
implementer, it reports the [route](GLOSSARY.md): the model tier and effort
that the item's type, labels and size call for, each with its rule. Several
small items from one area of the code travel the same way, in one pull
request with one commit each, so their review is paid once.

Then a [drive loop](GLOSSARY.md) runs the review rounds with nobody watching.
Each round is a fresh agent, which gives every open review thread an
outcome: a fix, or a reply that says why not. A round also settles a stopped
merge or rebase so both sides' intent survives. When continuous integration
([CI](GLOSSARY.md)) turns red, the drive runs a repair round of its own,
within a budget. The drive stops in one named end state, such as converged,
waiting on a person or conflicting. A person merges. Outside a drive, an
agent fixes a failed CI run from its log.

A drive survives its driver. Its state lives in a
[drive ledger](GLOSSARY.md) on the pull request, so a drive started on one
machine resumes on another. A driver that dies, or stays alive without
progress, can be taken over from any clone, and a driver that is making
progress never is. A drive stops for a person only on the decisions the
repository reserves for one. Each stop carries its question framed: the
options, what each costs, and the one the agent recommends. Where the
workspace runs in Orca, the question reaches a person's phone. The answer is
a comment on the pull request, and with the line running
[unattended](#a-line-that-runs-with-nobody-at-the-keyboard), that comment
restarts the drive.

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

## A line that runs with nobody at the keyboard

"At six the line stops. Assigned items wait for someone to open a session; a
drive that hit a usage limit waits for morning."

The [dispatcher](GLOSSARY.md) is a program on the machine that runs the
agent sessions. Every few minutes it reads the issue tracker, the pull
requests and the running sessions. It works out which stage of the work
should be running and is not, and reports each one with its evidence. It
starts only the stages the machine allows it to start.

It restarts a review drive that stopped on a usage limit, on another
account, or on a question a person has answered. It drives a converged pull
request again once it conflicts with its base or gains a commit the drive
did not check. It starts a session for an item assigned to the team's
[factory identity](GLOSSARY.md), and the repository's follow-up after a
merge, which settles what the merge still owes. Those two start only where
each session can be tied to the account it bills. Every session bills a
subscription account the machine lists, within a cap per account. The
account decides whether the session runs in Claude Code or Codex.

What only a person can settle reaches their phone, once: a parked decision
with its question framed, a failed follow-up, an item claimed and then left
alone. The dispatcher never merges and never answers a parked question. It
never restarts a drive a person stopped.

An agent inspects work the rules leave waiting, every 20 minutes when its
input changes. This [steward](GLOSSARY.md) proposes routine recoveries and
values for missing issue fields. It frames what needs a person. The
dispatcher checks each proposal before acting.

Every session it started leaves a row in the [outcome log](GLOSSARY.md)
when it ends: the stage, the account, how long it ran and how it ended. One
dashboard opens on the pull requests ready to merge, or on what needs a person
when none are ready. Its other views show which account holds which session,
what comes next, and the log, filtered by time, repository, stage, account and
outcome. A stage that falls behind what it should achieve is reported as
[stage drift](GLOSSARY.md), and a person decides what happens to it. The one
prompt the dispatcher types into a session by itself is "continue", once a
usage limit has reset.

With [dispatch labels](GLOSSARY.md) turned on, each pull request shows its
state as a label: driving, converged, parked or held, among others. A person
steers with two labels of their own. One asks for a drive, and the other
keeps the dispatcher away from that pull request.

A person can also ask the line in a sentence: "where does 456 stand", or
"what is waiting on me". The [operator](GLOSSARY.md) skill reads the answer
from the line's records with `jig ask`. Told to hold a pull request or to
answer a parked question, it shows what `jig send` would write and sends it
once the person agrees.

Some pull requests conflict whenever two of them move at once, such as two
database migrations. A team marks such an area of its code as
[serialized](GLOSSARY.md), and the dispatcher drives its pull requests one
at a time, the one closest to merge first. The others are
[held](GLOSSARY.md) until each leads, and the outcome log records how long
each waited.

Nothing needs restarting after a night: the timer ran every few minutes. In
the morning a person reads one report of what the drives and the dispatcher
did. They answer each park from the phone and merge what converged.

The dispatcher is one part of the [`jig` command](plugin/README.md#the-jig-command),
which installs, checks, updates and removes the plugin's tools on a machine.
Its timers also keep the plugin on its channel's newest version. A pinned
machine stays where it is. A machine whose jobs an older release installed
runs `jig upgrade` once to turn this on.
The dispatcher starts sessions through a [session runtime](GLOSSARY.md).
Orca is the first, and another runtime joins by implementing the same
interface.

- **Skills:** [`do-item`](plugin/skills/do-item/SKILL.md),
  [`steward`](plugin/skills/steward/README.md),
  [`drive-pr`](plugin/skills/drive-pr/README.md),
  [`operator`](plugin/skills/operator/SKILL.md)
- **Practice:** [M7](modules/M7-pr-lifecycle-review/),
  [M12](modules/M12-parallel-agent-ergonomics/),
  [M11](modules/M11-process-observability/),
  [M3](modules/M3-change-area-catalog/)
- **On the roadmap:** a launch guard and an Orca panel for what waits on a
  person (item 34)

## Review in tiers, with an arbiter for contested findings

"The migration got the same quick look as the typo fix. Then the bot and the
agent argued over one finding for two days."

`change-areas` resolves a change against the repository's
[change-area catalog](GLOSSARY.md), a map of the code's areas and what each
one owes. It says which areas a change touches and what that owes: the CI
jobs, the checks before a push, the mandatory reviews, the tracker labels,
the steps after a deploy. It checks the catalog itself too. `review` checks a
diff, a plan or a pull request in tiers: pattern checks, contract checks,
then semantic review against the repository's decision rules and the
reviews the catalog makes mandatory. Its last tier also runs
[review lenses](GLOSSARY.md), single checks kept one to a file, for the
rules no gate can judge. `github-actions` reviews
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
- **On the roadmap:** lenses for more rules the modules state (roadmap
  item 23); `drive-pr` and `fix-ci` reading their checks from the
  catalog, and a lint for copies of its paths (Later)

## A learning loop built into the process

"The session worked something out at two in the morning. By nine it was
gone."

[Reflection](GLOSSARY.md) is a step in the process, not a meeting. `reflect`
runs at a natural end: a converged drive, an addressed review, the end of a
session, or before a worktree is removed. It reads what the session recorded
about the repository's scaffolding, merges duplicates, names each finding's
class and writes it to a store every repository shares. `review-reflections`
turns the stored findings into changes a person approves, and a class that
keeps recurring is escalated to one tracker issue instead of filed again.
`promote-memory` moves a lesson from an agent's private memory into a
reviewed, shared document. The stores meet one contract, checked by one
conformance suite: a folder, a Notion database people browse and filter, and
the issues of one GitHub repository.
Around the skills, the [miss→lens flywheel](GLOSSARY.md) answers each
significant miss with an additive check, validated on a replayable fixture
before it may block anything.

- **Skills:** [`reflect`](plugin/skills/reflect/README.md),
  [`review-reflections`](plugin/skills/review-reflections/README.md),
  [`promote-memory`](plugin/skills/promote-memory/SKILL.md)
- **Practice:** [M8](modules/M8-learning-loop/),
  [M9](modules/M9-tasks-memory/)
- **On the roadmap:** the Notion store run against Notion itself (roadmap
  item 7); a Jira store for reflections (Later)

## Decisions recorded, found again, and turned into checks

"We settled that last month. The agent argued it again and went the other
way."

`adr` creates, updates and checks [decision records](GLOSSARY.md) and the
machine-readable rules derived from them, so a settled decision becomes
something a review can test rather than a document nobody reopens. `decide`
settles a technical dilemma by searching the repository's precedent first,
then ruling or escalating to a person with a cited decision sheet. `explain`
writes a cited, commit-dated explainer of how part of the system works
today, for a decision, a review or onboarding.

For a broad topic before it becomes one work item, `orchestrate` keeps the
discussion with the person while separate sessions survey the topic, record
decisions and prepare the work to start.

- **Skills:** [`adr`](plugin/skills/adr/SKILL.md),
  [`orchestrate`](plugin/skills/orchestrate/README.md),
  [`decide`](plugin/skills/decide/SKILL.md),
  [`explain`](plugin/skills/explain/SKILL.md)
- **Practice:** [M5](modules/M5-adr-practice/)

## Design and planning grounded in the repository

"The plan read well in the meeting. The first agent to build it found that
the table it assumed did not exist."

The feature pipeline runs from research through requirements and
architecture to a design loop and an [epic](GLOSSARY.md) of planned work
items, with a template for each stage
([PIPELINE.md](modules/M6-feature-delivery-pipeline/templates/PIPELINE.md)).
`red-team` reviews a requirements or architecture document adversarially.
Personas, from a critical chief technology officer to a reader who knows no
engineering terms, each read it in fresh context. Each reports the passage,
the risk and the question the author must answer, in one report.
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

"The pull request looked fine, merged, and main went red."

Every rule names where it lives on the [enforcement ladder](GLOSSARY.md),
from a written convention to a check that blocks the merge, and the audit
scores exactly that. The modules ship reference gates with their own tests.
A [grep gate](GLOSSARY.md) fails on a forbidden pattern. A
[ratchet](GLOSSARY.md) tolerates the findings a codebase already has and
refuses new ones. A commit-message marker and freshness checks for anything
derived from a source complete the set. Pipeline economy spends CI only where
it changes a merge decision, and the testing strategy sets tiers with
budgets.

- **Practice:** [M1](modules/M1-gates-enforcement-ladder/),
  [M2](modules/M2-generated-artifact-freshness/),
  [M13](modules/M13-pipeline-economy/),
  [M14](modules/M14-testing-strategy/)

## Change notes, and a changelog nobody fights over

"Three agents opened three pull requests, and all three edited the
changelog. Each merge put the other two in conflict."

A pull request whose change the software's users would notice adds a
[change note](GLOSSARY.md): a small file of its own. It never edits the
changelog or the version. After the merge, a release step writes the notes
into the changelog, moves the version by the largest bump a note asks for,
and deletes the notes. The release is tagged once its commit passes its
checks. Two pull requests never edit the same lines, so merging one does not
put the others in conflict. The `changelog` skill turns this on in a
repository whose configuration names its changelog file. It reads Keep a
Changelog or Common Changelog format, with the version in a file or in tags.
Its commands check a branch or the whole changelog, show the next release
and run the release step. A GitHub Action and a workflow template run them
in CI. They push the release directly, or as a release pull request a person
merges, and a guided setup covers the GitHub App, the branch rules and the
workflow. Jig's own releases are made this way.

- **Skills:** [`changelog`](plugin/skills/changelog/README.md)
- **Practice:** [M12](modules/M12-parallel-agent-ergonomics/),
  [M16](modules/M16-releases-versions/)
- **On the roadmap:** a changelog and a version per released artifact in one
  repository, and workflow templates for CI providers other than GitHub
  (roadmap item 21)

## Workspaces for many agents on one machine

"Two agents on one machine started their servers on the same port, and last
month's worktrees fill the disk."

Several agents on one machine and one repository collide on ports, shared
resources and the files every pull request edits. The module gives each
workspace its own ports and locks, sets the worktree lifecycle, and nudges a
reflection before a worktree is removed. The [launcher](GLOSSARY.md) wires
an issue tracker's "open in coding agent" button to a workspace. It assigns
the issue and writes the whole issue to a file the agent reads. It picks the
repository from the issue's label and opens the workspace through a
[provider](GLOSSARY.md). Herdr is the [workspace runtime](GLOSSARY.md) the
tooling targets first, on macOS, Linux and remote hosts. The
[Herdr workspace tool](tools/herdr/README.md) opens an issue's branch as a
worktree workspace, starts its agent and sends its first prompt, once. It
reattaches rather than duplicating either, and runs the repository's
worktree create and remove hooks. Orca, the desktop and remote agent
environment, is supported the same way. The
[Orca workspace tool](tools/orca/README.md) opens an issue's branch as an
Orca worktree, on this machine or on a paired Orca server. It names the
worktree as the repository names its branches, runs the create hook and
starts the agent, once. On a machine with the plugin installed, a workspace
needs no setup of its own. That holds in Herdr, Orca, Conductor or any tool
that creates worktrees and starts sessions with the user's agent
configuration. A remote host, a container or an isolated configuration
directory needs its own install
([where it works](plugin/README.md#where-it-works)).

Agent sessions also leave worktrees, scratch directories and tool state
behind. The [`jig gc`](plugin/gc/README.md) command, shipped with the plugin,
reports what remains, checks whether it is still in use, and writes a
[collection receipt](GLOSSARY.md) for every run. A repository declares the
resource kinds and paths its tools create. A person confirms those bounds
when installing a machine's daily job, on launchd on macOS, systemd user
timers on Linux, or cron where neither is available. Collecting runs read
the declaration from the recorded remote base branch and stay within the
confirmed bounds. A worktree Orca manages is collected through Orca, so its
card and terminals go with it. Other worktrees, scratch directories and tool
state are reported only, because collecting them needs the tools that create
and use them to take part. Old receipts can be collected, keeping the latest
report for each repository and kind.

- **Practice:** [M12](modules/M12-parallel-agent-ergonomics/)
- **On the roadmap:** the skills checked inside Herdr (roadmap item 19), a
  runnable workspace lifecycle for other runtimes (Later); collecting what is
  only reported, and more kinds (roadmap item 24)

## One configuration file, read in layers

"We copied the scripts and typed our gate command and tracker labels into
each one. Every upgrade since has been a merge by hand."

A repository keeps its own values in one
[configuration file](plugin/CONFIGURATION.md): its gate command, reviewers,
tracker team and labels, pull-request policy, change-area catalog. Values
are read in [layers](GLOSSARY.md), for the person, the repository and the
single run. Every field is documented with its default and the skills that
read it, and the audit checks the configuration against the repository.
Each binding to a named tool stands behind an interface. The skills reach
the issue tracker through a small [tracker interface](GLOSSARY.md), with
adapters for Linear, GitHub Issues and Jira. Another tracker is a new
adapter, not a change to the skills. [EXTENDING.md](plugin/EXTENDING.md)
lists every point where an organization plugs in its own commands, skills,
reviewers and stores.
`/jig:jig` tells an agent which skill fits a task and where a value or a
practice is documented, from the reference installed with the plugin. When
Jig itself is wrong, it drafts the bug report for Jig's tracker, with the
repository's own names left out, for a person to confirm.

- **Skills:** [`jig`](plugin/skills/jig/README.md)
- **Practice:** [M0](modules/M0-instruction-architecture/),
  [M9](modules/M9-tasks-memory/)
- **On the roadmap:** a plan-file tracker adapter (roadmap item 12); the
  values the skills still assume (roadmap item 10), and an `init` command
  that writes this file (roadmap item 26)

## Documents that say what is true now

"Three agents used three names for one thing, and the docs described a
design we dropped in the spring."

Instruction files are layered so a rule loads only where it applies, with a
glossary so parallel agents use one word for one thing. The docs tree is
governed: a schema, a generated index, and [de-scarring](GLOSSARY.md), which
`descar` performs by removing review traces, struck corrections and
superseded statements from a promoted page. `docs` checks the whole tree in
one pass: frontmatter, index, dates, scars and deferrals. It flags drafts
left stale and lists the documents the project's type calls for and the tree
lacks. Its gates run the same way in a repository's hooks and CI.
`programmatic-execution` runs a bulk read-only check (cross-references,
links, a search across many files) as one script whose findings are a
compact list, instead of reading every file into the conversation.

- **Skills:** [`docs`](plugin/skills/docs/README.md),
  [`descar`](plugin/skills/descar/SKILL.md),
  [`programmatic-execution`](plugin/skills/programmatic-execution/SKILL.md)
- **Practice:** [M0](modules/M0-instruction-architecture/),
  [M4](modules/M4-docs-governance/)

## Adopt one module at a time, sized by a profile

"The framework wanted every practice on day one, and a two-person repository
does not need forty rules."

No module requires another's strictest level. Each has three
[maturity levels](GLOSSARY.md) defined by observable criteria. A
[profile](GLOSSARY.md) says which modules a project needs at which level: a
few at Lite for a one-person project, most at Strict for regulated work. The
adoption guides give an order for an existing repository
([brownfield](adoption/brownfield.md)) and a new one
([greenfield](adoption/greenfield.md)). A team graduates to the next profile
when its answer to the profile's question changes.

- **Practice:** every module, composed by [profiles](profiles/README.md), as
  [principle 2](principles/02-modular-profile-composed.md) asks
