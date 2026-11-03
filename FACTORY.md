# Jig as a software factory

Agents open pull requests faster than a team can review them. Each agent
session starts cold, forgets what it learned when it ends, and stops only at
the checks that exist. When nobody is at the keyboard, the work waits: an
assigned item, a review that hit a usage limit, the follow-up a merge owes.

A [software factory](GLOSSARY.md) holds the work. Work enters in a standard
form and passes through the same stations and the same checks every time. It
comes out measured, so the output stays predictable as the volume grows. This
page follows one work item along the line first. Then it shows what runs the
line with nobody at the keyboard, how a team decides what to build, and what
every station stands on.

The detailed contracts are in the modules: the feature pipeline is
[M6](modules/M6-feature-delivery-pipeline/), the pull-request loop is
[M7](modules/M7-pr-lifecycle-review/) and the learning loop is
[M8](modules/M8-learning-loop/). [The mechanism map](plugin/MECHANISMS.md)
says which parts of each station are scripts with no model in them and which
are a model deciding. Every term of art is in [the glossary](GLOSSARY.md).

## The line

Every change passes the same [stations](GLOSSARY.md), one work item at a
time. A station is one fixed step, with its input, its output and who runs
it. A [skill](GLOSSARY.md), a named procedure an agent follows, runs most of
them, and the plugin ships the skills.

| # | Station | What happens | Run by |
|---|---------|--------------|--------|
| 1 | Pick up | A tracker item becomes a branch, a workspace and a plan, and goes to the right agent. The agent works an epic one sub-issue at a time. | [`do-item`](plugin/skills/do-item/SKILL.md); the tracker's "open in coding agent" button through the [launcher](tools/launcher/README.md) |
| 2 | Build | The agent makes the change and its validation plan. A review before the first push checks it in tiers. A small change skips the tiers and keeps the reviews its areas require. | `do-item`, [`review`](plugin/skills/review/SKILL.md) |
| 3 | Open | A pull request shaped by the repository's declared policy: draft or ready, its base, its size. Several small items from one area can share one. | `do-item`; [`work-batch`](plugin/skills/work-batch/README.md) for a batch |
| 4 | Drive | Review rounds run unattended. Each round waits for the reviewers and gives every finding one recorded outcome. Then it fixes, verifies, pushes and resolves. An arbiter rules on contested findings. | [`drive-pr`](plugin/skills/drive-pr/README.md), [`resolve-review-comments`](plugin/skills/resolve-review-comments/README.md), the [`review-arbiter`](plugin/agents/review-arbiter.md) agent |
| 5 | Repair | Red CI or a conflict with the base gets a bounded repair round, and the drive checks again. | `drive-pr` with [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md); [`fix-ci`](plugin/skills/fix-ci/SKILL.md) run on its own |
| 6 | Merge | A person merges. | a person |
| 7 | Follow up | After a merge, the dispatcher starts the repository's follow-up, which settles what the merge owes. Deferred review findings become tracked follow-up items. Jig's own follow-up skill does this for Jig. | The repository's follow-up command, started by a person or the [dispatcher](plugin/README.md#the-dispatcher) |

Follow-up items enter the line again at station 1, so the line is itself a
loop. At station 4 the review rounds run unattended, as one
[PR drive loop](GLOSSARY.md), a drive for short. A drive stops on one named
end state, such as converged, waiting on a person, or in conflict. It never
approves and never merges. With nobody at the keyboard,
the [dispatcher](#with-nobody-at-the-keyboard) starts stations 1, 4 and 7.

Every change follows the same pull-request loop, and the stations run it:

1. **Develop** on a branch, and reuse a remote branch before creating one.
   Open a draft pull request early, so CI and the review bots start, or a
   ready one where the repository's policy says so.
2. **Review rounds.** Reviewers in layers read each round: an in-house shadow
   reviewer, commercial bots, people. What changed decides which review steps
   are mandatory.
3. **Resolve every comment.** Each thread gets one recorded outcome:
   accepted and fixed, rejected with the reason, won't fix, deferred to a
   filed item, or moot
   ([the outcomes](plugin/skills/resolve-review-comments/README.md#outcomes)).
   Once the draft reviewers settle, a person or the drive marks the pull
   request ready, and the reviewers that wait for that join. The loop ends
   when a later round settles with nothing left, every expected reviewer has
   reported on the current head, and the build is clean.
4. **Merge.** A person merges once no conflict is left, and the follow-up
   updates the tracker.

On the roadmap:
[a converged drive arming the merge it certified](ROADMAP.md#9-delegated-merge-pull_requestsmerge-auto-on-converged).
It would change "a person merges", so it gets a decision of its own. Also on
the roadmap:
[a follow-up skill for every repository](ROADMAP.md#17-corrected-designs-for-the-existing-modules),
and [a drive's repair round running `fix-ci`](ROADMAP.md#later).

## With nobody at the keyboard

The line's skills start when someone types them. At night, in a meeting or
away from the desk, nobody does, and the work waits at the next station. The
[dispatcher](GLOSSARY.md) is a small program on the machine that runs the
agent sessions. A timer runs it every few minutes, and each run, a
[tick](GLOSSARY.md), starts the stations that should be running and are not.

### What it starts

Each tick reads the tracker, the pull requests and the sessions already
running, and the records it keeps on the machine: the sessions it launched,
the nudges and notifications already sent, and the outcome of each stage.
Those records survive stopping the dispatcher, so a restart loses nothing and
starts no stage twice. Then it starts:

- **A pickup** for each item assigned to the repository's
  [factory identity](GLOSSARY.md): the tracker user a team assigns work to
  when the factory should take it. The session claims the item and carries it
  to a pull request.
- **A [re-arm](GLOSSARY.md)** of each drive that stopped on something a
  machine can settle: a usage limit, on another account, or a question a
  person answered.
- **A [re-drive](GLOSSARY.md)** of each converged drive gone stale: its pull
  request now conflicts with its base, or its head moved past the head the
  drive checked.
- **The follow-up** after each merge, which settles what the merge owes.

A tick reports what it would start, and why, before a team lets it start
anything. Every session it starts gets a [launch record](GLOSSARY.md) first,
so a launch whose answer is lost is never followed by a second one.

The dispatcher opens workspaces and starts agents through a
[session runtime](GLOSSARY.md). Orca is the first one. Another runtime, Herdr
among them, joins as a second implementation of the same interface once it
can list a host's accounts. On Orca, the dispatcher reports
pickups and follow-ups for a person to start. Orca opens a new session on
whichever account its host has selected, and a pickup needs the account the
dispatcher chose. The dispatcher ships in the plugin, and
[the `jig` command](plugin/README.md#the-jig-command) installs its timer and
checks it.

### What reaches a person

Some stops only a person can settle: a question a drive
[parked](GLOSSARY.md) for a person, a failed follow-up, a pickup that
stalled. The dispatcher tells a person once per cause. With Orca, the message
becomes the comment on the workspace of the pull request or item, and the
dispatcher marks that workspace unread, which Orca's phone app shows. A
person answers a parked question with a comment on the pull request, and the
next tick re-arms the drive.

A running stage can fall short of what it should achieve: a drive whose open
review threads stop falling, or a pickup with no pull request in time. That is
[stage drift](GLOSSARY.md). The dispatcher reports it and tells a person
once, and the person decides whether to stop the stage.

Nothing needs restarting after a night: the timer ran every tick. In the
morning one report lists what each drive did and what the dispatcher started,
refused and notified. A person answers the parks, settles what only a person
can, and merges what converged.

A team can turn on [dispatch labels](GLOSSARY.md). They show each pull
request's state where the pull request lives, on the [forge](GLOSSARY.md):
driving, converged, parked or held, among others. A person steers with two
labels of their own. One asks for a drive, and the other keeps the dispatcher off the pull
request.

### The outcome log and its dashboard

Every session the dispatcher started leaves one row in the
[outcome log](GLOSSARY.md) when it ends. The row holds the stage, the
repository, the account, the model, how long the session ran and how it
ended. How it ended is one class from a closed list: converged, merged, a
usage limit, parked for a person, stalled, died, refused, or gates failed.
The log records a stop no class fits as unknown, and never drops it.

One dashboard filters the log by time, repository, stage, account and class,
and counts each class. A phone opens it as well as a desk. It writes nothing
and makes no report files. A class that keeps coming back is a finding about
the scaffolding, and [the learning loop](#the-loop-that-sharpens-it) is where
a person approves the change.

### Accounts and their usage limits

Each session bills to a subscription account, Claude Code's or Codex's, and
the account decides which agent the session runs in. Each account runs a
capped number of sessions at once, each one a [slot](GLOSSARY.md). When a
session stops on an account's usage limit, the dispatcher records a
[wall](GLOSSARY.md). It leaves the account out of every launch until the
limit resets. A drive stopped there is re-armed on another account at the
next tick.

Once a limit resets, an interactive session the dispatcher started whose last
record is still that limit gets the one [nudge](GLOSSARY.md) the dispatcher
ever types, a fixed sentence asking it to continue. It is sent only when the
agent's input line is empty, no menu or question is showing and nobody has the
workspace open. Anything else a stuck session needs goes to a person.

### Contended areas, one at a time

Some pull requests conflict whenever two move at once: two migrations, or two
edits to one schema. A team marks such an area as a
[serialized area](GLOSSARY.md) in its
[change-area catalog](GLOSSARY.md), the file that says what each kind of
change implies. The dispatcher drives that area's pull requests one at a
time, the one closest to merge first. The others wait, [held](GLOSSARY.md),
and the outcome log records how long each waited. A person adds the mark,
never the dispatcher.

### What it never does

- **Merge.** A person merges, here as at station 6.
- **Answer a parked question.** The question is a person's, and so is the
  answer.
- **Start a second session on a claimed item.** A stalled pickup, or an item
  two sessions joined, goes to a person.
- **Stop a driver that is making progress.** It takes over only a stalled
  driver its own machine started.
- **Change its own limits.** A class that recurs on the dashboard goes to a
  person as a finding.

On the roadmap:
[pickups and follow-ups started on Orca](ROADMAP.md#33-the-dispatcher-a-tick-that-starts-the-execution-lines-stages),
and
[a tick the moment an agent stops or waits](ROADMAP.md#34-jig-in-the-orca-ecosystem).

## Deciding what to build

Before an item reaches the line, a team decides what to build and how. A
feature or an [epic](GLOSSARY.md), a set of work items worked one at a time,
passes through stages. A reviewer checks each stage before the next one uses
it.

1. **Research.** A dated research note per question: the options, the
   evidence and a recommendation. Research that changes a decision becomes an
   architecture decision record, an [ADR](GLOSSARY.md).
2. **Requirements.** A product requirements document, the **PRD**, says
   *what* the feature does for its users, from the committed template. It
   names no technology.
3. **Architecture.** *How* the team builds it, from the template. Its
   significant decisions become ADRs.
4. **Prototype** (user-interface work only). A brief, a generated prototype,
   an adversarial review by a strong reviewer agent, and another round. The
   prototype often improves the requirements and the architecture, so both
   stay open. The team imports the accepted prototype in a standard form, and
   checks again what it means for the architecture.
5. **Plan and file.** An epic of work items, each with a clear plan. Flag
   labels, such as a migration, an API change or a person's decision, decide
   which gates fire further down the line.

**At every stage**, a reviewer reads the artifact as an adversary, and the
author iterates until it clears. Then the author
[de-scars](GLOSSARY.md) it: the final artifact states only what is true now,
and the findings stay in the review threads and issues.

The skills that run stations at this level:

| Skill | Station |
|-------|---------|
| [`explain`](plugin/skills/explain/SKILL.md) | Before deciding: a cited, dated account of how that part of the system works |
| [`decide`](plugin/skills/decide/SKILL.md) | A technical dilemma: checked against the decisions already made, then ruled or escalated to a person, and recorded |
| [`adr`](plugin/skills/adr/SKILL.md) | Architecture: the decision record, and the rules a check can derive from it |
| [`red-team`](plugin/skills/red-team/SKILL.md) | Requirements and architecture: an adversarial review by personas, each in a fresh context, in one report |
| [`design-brief-builder`](plugin/skills/design-brief-builder/SKILL.md) | Prototype: the brief for an external design session, and the returned bundle merged and checked |
| [`review`](plugin/skills/review/SKILL.md) | Every stage: a plan or a document reviewed against the repository's decisions |

A person sets the intent, accepts each stage's artifact and takes the
decisions `decide` escalates.

On the roadmap: [the greenfield kickoff](ROADMAP.md#3-the-kickoff-family),
which starts a new repository from nothing, and
[epic planning on the tracker](ROADMAP.md#later).

This part of the factory hands the line its work:

| Part | Unit of work | What it decides | What it hands on | Modules |
|------|--------------|-----------------|------------------|---------|
| **Deciding what to build** | a feature or an epic | what to build, and how | accepted requirements and architecture, decision records, an accepted design, an epic of planned work items | M5, M6 |
| **The line** | one work item | how this item gets built and merged | a merged pull request, and filed follow-ups | M7, M9 |

## What it stands on

Every station hands its work to an agent session. A session knows only what
its context gives it, and follows only what it is told. Only the checks that
exist stop it, and it forgets everything when it ends. So the stations
produce reliable work only in a repository whose
[scaffolding](GLOSSARY.md) does the jobs below. Scaffolding is everything in a
repository that exists to guide agents: instruction files, skills, a glossary,
checks.

| Job | What it means | Jig's modules | Without it |
|-----|---------------|---------------|------------|
| **Context** | What an agent knows as it starts and works: the rules that apply here, this project's words, what a change implies, the plan for the item | [M0](modules/M0-instruction-architecture/): instruction files in layers, rules that load where they apply, a glossary, written dispositions. [M3](modules/M3-change-area-catalog/): what each kind of change implies. [M4](modules/M4-docs-governance/): a docs tree with an index and rules. [M9](modules/M9-tasks-memory/): work items that carry their plan, and memory | Each session guesses the conventions. Context is bloated, or silent exactly where the work happens. Parallel agents invent different words for one thing |
| **Verification** | *Guides* that steer an agent before it acts, and *catches* that stop what slips through. Each rule sits on a named rung of the [enforcement ladder](GLOSSARY.md) | Guides: M0 instructions, [M6](modules/M6-feature-delivery-pipeline/) templates, [M5](modules/M5-adr-practice/) decisions, M3's validation plan. Catches: [M1](modules/M1-gates-enforcement-ladder/) tested gates with CI as the authority, [M2](modules/M2-generated-artifact-freshness/) freshness checks, M5 decisions turned into checks, [M7](modules/M7-pr-lifecycle-review/) layered review, [M10](modules/M10-environments-deploy/) verification before deployment | Plausible-looking agent output merges because nothing fails. Rules that "we always follow" erode without anyone noticing |
| **Knowledge** | Decisions, facts and lessons kept explicit, versioned and findable, so the next session starts where the last one ended | M5 decision records. M4 document lifecycle and [de-scarring](GLOSSARY.md). [M8](modules/M8-learning-loop/): significant misses answered with checks proven on replayable test cases. M9 memory promoted into shared documents. M0's glossary | Settled questions are argued again, the same mistake recurs, and every session starts cold |

Running many agents at once adds two needs: workspaces that do not collide
([M12](modules/M12-parallel-agent-ergonomics/)), and measurement of the
process itself, so decisions about gates and reviewers rest on data
([M11](modules/M11-process-observability/)).

### What Jig provides to build it

Building that scaffolding is most of what Jig is. The skills that run the
stations are a small part, and they depend on it. They read the repository's
instructions, its checks, its change areas and its tracker's labels. A
repository without them gives the skills little to work from.

- **A practice for each part.** A set of [modules](modules/README.md), each
  stated as an [invariant](GLOSSARY.md): a rule that names no tool. Each comes
  with adoption steps, templates to copy and reference gates with their own
  tests. Each maps its practice onto the common CI providers, hook managers,
  trackers and agent runtimes.
- **Sized to the project.** Each module has three
  [maturity levels](GLOSSARY.md), defined by criteria a reader can observe.
  [Profiles](profiles/README.md) say which modules a project needs at which
  level: a few at Lite for a one-person project, most at Strict for regulated
  work. A team climbs one level at a time.
- **Measured, not assumed.** The [audit](plugin/skills/audit/README.md)
  scores a repository against every module's criteria, with file-path
  evidence. It recommends the next step in the repository's own tools and,
  run again, reports what drifted.
- **Fitted to how the organization works.** A team adopts one module at a
  time, and no module needs another at its strictest level. The
  organization's own values live in its
  [configuration](plugin/CONFIGURATION.md), read in [layers](GLOSSARY.md):
  the command that runs its checks, its reviewers, its tracker's team and
  labels. The skills read it when they run, and the audit checks it against
  the repository. Where a skill needs a named tool, an interface stands
  between them. The [tracker interface](GLOSSARY.md) has adapters for GitHub
  Issues, Linear and Jira; a few operations, such as the review skill's
  deferral step, still call Linear directly
  ([the exceptions](plugin/EXTENDING.md#issue-tracker)), and the pull-request
  skills have no forge interface yet. The [workspace launcher](tools/launcher/README.md)
  opens workspaces in Herdr, which Jig's tooling targets first, in Orca and
  in Conductor. The skills run in Claude Code and Codex, and the pull-request
  skills work with GitHub. An organization's own skills, gates and review
  lenses live in its own repositories, beside Jig's.
- **Kept current.** [The learning loop](#the-loop-that-sharpens-it) turns
  significant misses into proven checks. Jig applies all of this to itself:
  its own gates, its own audit record, its own review loop.

The [principles](principles/README.md) behind it, in particular
[AI scaffolding as the spine](principles/03-ai-scaffolding-as-the-spine.md)
and [enforcement-ladder discipline](principles/04-enforcement-ladder.md), say
why it is built this way.

## The loop that sharpens it

A significant miss, one an automated step should have caught, becomes a check
([M8](modules/M8-learning-loop/)). The team classifies the miss, rebuilds it
as a test case that replays it, and answers it with an added check. The check gates only
once it catches its test cases. Its recall, precision and cost then decide
whether it is kept, promoted or removed. So the line gets sharper without
anyone watching harder.

Review outcomes are the measure's raw data. Each reply that settles a thread
opens with its recorded outcome, so a reviewer's hits, false positives and
declined findings can be counted. Deferred findings return to the line as
work items. Session reflections and promoted memories feed the same
scaffolding, through [`reflect`](plugin/skills/reflect/README.md),
[`review-reflections`](plugin/skills/review-reflections/README.md) and
[`promote-memory`](plugin/skills/promote-memory/SKILL.md).

The [audit](plugin/skills/audit/README.md) inspects the factory itself. It
scores the repository against every module and, run again, reports what
drifted ([principle 6](principles/06-audit-first.md)).

## What stays with a person

Jig automates the stations and keeps these decisions with people:

- The intent: what to build, and the acceptance of each design stage.
- The dilemmas `decide` escalates, and the review findings a drive marks for
  a person.
- The answer to a parked question, and what to do about a stage that drifts.
- The merge.
  [Delegating it](ROADMAP.md#9-delegated-merge-pull_requestsmerge-auto-on-converged),
  for a repository that chooses to, is on the roadmap.
- Promotion to production ([M10](modules/M10-environments-deploy/)).
- Changes to the scaffolding that agents propose from their own sessions
  (M8).

## What the platform supplies

The machines, environments, deployment and monitoring a factory runs on are
not Jig's. Each module states what the repository needs from them, so any
platform can supply it:

- **Parallel workspaces**: many agents on one machine without colliding
  ([M12](modules/M12-parallel-agent-ergonomics/)). A team installs the plugin
  once per machine. It needs no setup per workspace in a tool that starts
  sessions with the user's own agent configuration: Herdr, Orca, Conductor
  and others. A runner with its own configuration directory, a container, or
  a tool without plugin support needs
  [the setup the plugin describes](plugin/README.md#where-it-works).
- **Environments and deployment**: verify what merged, ship only what was
  verified, promote by hand, and use disposable preview environments
  ([M10](modules/M10-environments-deploy/)).
- **Measurement**: the delivery process emits typed events, so review
  quality, gate health and cycle time are measured rather than assumed
  ([M11](modules/M11-process-observability/)).
- **Supply chain**: third-party automation pinned and updated, and
  dependencies held back by a [release cooldown](GLOSSARY.md) and an
  [install-script allowlist](GLOSSARY.md). Secrets are scanned in layers, and
  reviewers are wired so the change under review cannot alter them
  ([M1](modules/M1-gates-enforcement-ladder/),
  [M7](modules/M7-pr-lifecycle-review/)).
