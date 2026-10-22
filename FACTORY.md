# Jig as a software factory

A [software factory](GLOSSARY.md) is a way of producing software in which
work enters in a standard form, passes through the same stations and the same
checks every time, and comes out measured, so that output stays predictable as
the volume of work grows. With AI coding agents doing much of the work at each
station, a factory's limit is no longer how fast people write code. It is how
well each agent session is informed, how reliably its work is checked, and how
much of what was learned survives the session.

This page shows what a factory of agents runs on, what Jig provides to build
it, and how the work then flows through the factory's stations. The detailed
contracts are in the modules: the feature pipeline is
[M6](modules/M6-feature-delivery-pipeline/)
([`PIPELINE.md`](modules/M6-feature-delivery-pipeline/templates/PIPELINE.md)),
the pull-request loop is [M7](modules/M7-pr-lifecycle-review/)
([`PR-LIFECYCLE.md`](modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md)),
and the learning loop is [M8](modules/M8-learning-loop/)
([`FLYWHEEL.md`](modules/M8-learning-loop/templates/FLYWHEEL.md)). Jargon:
see [GLOSSARY.md](GLOSSARY.md).

## A factory of agents runs on scaffolding

A factory hands each station to an agent session. A session knows only what
its context gives it, follows only what it is told, is stopped only by checks
that exist, and forgets everything when it ends. So stations, however well
automated, produce reliable work only in a repository whose
[scaffolding](GLOSSARY.md) does three jobs:

| Job | What it means | Jig's modules | Without it |
|-----|---------------|---------------|------------|
| **Context** | What an agent knows when a session starts and while it works: the rules that apply here, the words this project uses, what a change implies, the plan for this item | [M0](modules/M0-instruction-architecture/) layered instruction files, rules that load only where they apply, a glossary, written dispositions; [M3](modules/M3-change-area-catalog/) what each kind of change implies; [M4](modules/M4-docs-governance/) a governed, indexed docs tree; [M9](modules/M9-tasks-memory/) work items that carry their plan, and memory | Each session guesses the conventions; context is bloated, or silent exactly where the work happens; parallel agents invent different words for the same thing |
| **Verification** | *Guides* that steer an agent before it acts, and *catches* that stop what still slips through, each rule on a named rung of the [enforcement ladder](GLOSSARY.md) | Guides: M0 instructions, [M6](modules/M6-feature-delivery-pipeline/) templates, [M5](modules/M5-adr-practice/) decisions, M3's validation plan. Catches: [M1](modules/M1-gates-enforcement-ladder/) tested gates with CI as the authority, [M2](modules/M2-generated-artifact-freshness/) freshness checks, M5 decisions turned into checks, [M7](modules/M7-pr-lifecycle-review/) layered review, [M10](modules/M10-environments-deploy/) verification before deployment | Plausible-looking agent output merges because nothing fails; rules that "we always follow" erode without anyone noticing |
| **Knowledge** | Decisions, facts and lessons kept explicit, versioned and findable, so the next session starts where the last one ended | M5 decision records; M4 document lifecycle and [de-scarring](GLOSSARY.md); [M8](modules/M8-learning-loop/) significant misses answered with checks validated on replayable fixtures; M9 memory promoted into shared documents; M0's glossary | Settled questions are argued again, the same mistake recurs, and every session starts cold |

Running many agents at once adds two needs: workspaces that do not collide
([M12](modules/M12-parallel-agent-ergonomics/)) and measurement of the process
itself, so decisions about gates and reviewers rest on data
([M11](modules/M11-process-observability/)).

## What Jig provides to build it

Building that scaffolding is most of what Jig is. The skills that run the
stations are a small part, and they depend on it: `do-item` and `drive-pr`
read the repository's instructions, gate command, change-area catalog,
pull-request policy and tracker labels, so in a repository without them they
have little to work from.

- **A practice for each part.** A set of [modules](modules/README.md), each stated
  as an [invariant](GLOSSARY.md) that does not depend on any tool, with
  adoption steps, copyable templates, reference gates that ship with their own
  tests, and a mapping onto the common CI providers, hook managers, trackers
  and agent runtimes.
- **Sized to the project.** Each module has three
  [maturity levels](GLOSSARY.md), defined by observable criteria rather than
  adjectives, and [profiles](profiles/README.md) say which modules a project
  needs at which level: a few modules at Lite for a one-person project, most
  of them at Strict for regulated work. A team climbs one level at a time.
- **Measured, not assumed.** The [audit](plugin/skills/audit/README.md) scores
  a repository against every module's criteria with file-path evidence,
  recommends what to do next in the repository's own tools, and, re-run,
  reports what drifted.
- **Fitted to how the organization works.** Jig is modular, configurable
  and extensible:
  - modules adopt one at a time, and none requires another's strictest level;
  - an organization's own values (its gate command, reviewers, tracker team
    and labels, pull-request policy, change-area catalog) live in
    [configuration](plugin/CONFIGURATION.md), in
    [layers](GLOSSARY.md) for the person, the repository and the single run,
    rather than in the skills' code, and the audit checks that configuration
    against the repository; the values the skills still assume (fixed tracker
    label groups in the review skill's deferral step, a remote named
    `origin`) are listed in [ROADMAP.md](ROADMAP.md) item 10;
  - bindings to a named tool go behind an interface where one has been built:
    the skills reach the issue tracker through a small
    [tracker interface](GLOSSARY.md) with adapters for Linear and GitHub
    Issues, so another tracker is a new adapter rather than a change to the
    skills (Jira and a
    plan file kept in the repository are ROADMAP.md item 12; the review
    skill's deferral step still calls Linear directly, item 10), and the
    [workspace launcher](tools/launcher/README.md) opens workspaces through
    providers in the same way: Herdr, the [workspace runtime](GLOSSARY.md)
    Jig's tooling targets first
    ([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)),
    gets the next provider (ROADMAP.md item 19), beside the Conductor
    provider already built;
  - the practices themselves name no tool, and each module maps them onto the
    common CI providers, hook managers, trackers and agent runtimes; the
    skills run in Claude Code and Codex, and some, such as `fix-ci` and
    `drive-pr`, still call GitHub directly;
  - an organization's own skills, gates and review lenses live in its own
    repositories beside Jig's, using the same configuration.
- **Kept current.** The [learning loop](#the-learning-loop-wraps-both) turns
  significant misses into validated checks, and Jig applies all of this to itself: its own
  gates, its own audit record, its own review loop.

The [principles](principles/README.md) behind it, in particular
[AI scaffolding as the spine](principles/03-ai-scaffolding-as-the-spine.md)
and [enforcement-ladder discipline](principles/04-enforcement-ladder.md), say
why it is built this way.

## Two levels and a loop around them

On that scaffolding, the factory's stations work at two levels:

| Level | Unit of work | What it decides | What it hands on | Modules |
|-------|--------------|-----------------|------------------|---------|
| **Design and planning** | a feature or an [epic](GLOSSARY.md) | what to build, and how | accepted requirements and architecture, decision records, an accepted design, an epic of planned work items | M5, M6 |
| **Execution** | one work item | how this item gets built and merged | a merged pull request, and filed follow-ups | M7, M9 |

The **learning loop** wraps both levels: a significant miss a station should
have caught becomes a candidate check, which gates only once validated and is
kept, promoted or removed on measurement (M8). The **audit** inspects the factory
itself: it scores the repository against every module and, re-run, reports
what drifted ([principle 6](principles/06-audit-first.md)).

## Design and planning: the feature pipeline

1. **Explore / research** — a dated research note per spike (options, evidence,
   recommendation). Research that changes a decision graduates into an ADR.
2. **PRD** — *what* the feature does for users, from the committed template.
   No stack talk here.
3. **Architecture** — *how*, from the template; significant decisions become
   ADRs.
4. **Design prototype loop** (UI work only) — brief → generated prototype →
   adversarial review by a strong reviewer agent → iterate; the prototype's
   product feedback often improves the PRD/architecture, so both stay open to
   revision. Import the accepted prototype in a standard, reusable form, then
   re-examine architectural implications.
5. **Plan & file** — decompose into an epic with sub-issues carrying a clear
   tactical execution plan; flag labels (migration, API change, human-in-the-
   loop, …) drive which gates will fire downstream.

**At every stage**: adversarial review of the artifact, iterate until cleared,
then **de-scar** — the final artifact is clean; findings history lives in the
review threads and issues.

The skills that run stations at this level:

| Skill | Station |
|-------|---------|
| [`explain`](plugin/skills/explain/SKILL.md) | Before deciding: a cited, dated explanation of how the part of the system in question works today |
| [`decide`](plugin/skills/decide/SKILL.md) | A technical dilemma: checked against the decisions already made, then ruled or escalated to a person, and recorded |
| [`adr`](plugin/skills/adr/SKILL.md) | Architecture: the decision record, and the checkable rules derived from it |
| [`design-brief-builder`](plugin/skills/design-brief-builder/SKILL.md) | Design prototype loop: the brief for an external design session, and the returned bundle merged and checked |
| [`review`](plugin/skills/review/SKILL.md) | Every stage: a plan or document reviewed against the repository's decisions |

A person sets the intent, accepts each stage's artifact and takes the
decisions `decide` escalates. On the roadmap: the greenfield kickoff and an
adversarial `red-team` reviewer ([ROADMAP.md](ROADMAP.md) item 3), and epic
planning on the tracker (ROADMAP.md, Later).

## Execution: the work-item line

The pull-request loop every change follows:

1. **Develop** on a feature branch (reuse an existing remote branch before
   creating one); open a **draft PR** early so CI and bot reviewers run, or a
   Ready one where the repository's pull-request policy says so: its declared
   `pull_requests.open_as`, or, when that is unset, an AI reviewer declared
   not to review drafts (`drive.reviews_drafts: false`;
   [CONFIGURATION.md](plugin/CONFIGURATION.md)).
2. **Review rounds** — layered reviewers (in-house shadow reviewer, commercial
   bots, humans), with mandatory review steps selected by what changed.
3. **Resolve every comment** — give each thread one recorded outcome:
   accepted (fixed here), rejected (wrong, with the reason), won't fix (valid
   but not worth the change), deferred (valid and owed, filed as a follow-up
   item) or moot (its code is gone), then resolve the thread
   ([the outcomes and what each leaves behind](plugin/skills/resolve-review-comments/README.md#outcomes)).
   Once the draft reviewers settle,
   a human, or a review driver at the round the repository's pull-request
   policy names, marks Ready, and the reviewers that wait for Ready join; loop
   until a round after Ready settles with nothing left, with every expected
   reviewer reported on the current head (zero open threads alone is not
   enough), and the build is clean.
4. **Human merge** — a human merges (a HITL decision); conflicts are resolved
   before merge, tracker updated after.

The plugin runs that loop as a line of stations, one work item at a time:

| # | Station | What happens | Run by |
|---|---------|--------------|--------|
| 1 | Pick up | A tracker item becomes a branch, a workspace and a plan, routed to the right agent; an epic is worked one sub-issue at a time | [`do-item`](plugin/skills/do-item/SKILL.md); the tracker's "open in coding agent" button through the [launcher](tools/launcher/README.md) |
| 2 | Build | The change, its validation plan, and a review before the first push: tiered, except that a change under 20 non-test lines skips the tiers but keeps the specialist reviews its change areas require and the runbook pass whenever a prescribed operator command changes ([`do-item`](plugin/skills/do-item/SKILL.md) states the rule) | `do-item`, [`review`](plugin/skills/review/SKILL.md) |
| 3 | Open | A pull request shaped by the repository's declared policy (draft or Ready, base, stacking, size); several small items from one area can share one | `do-item`; [`work-batch`](plugin/skills/work-batch/README.md) for a batch |
| 4 | Drive | Review rounds run unattended: wait for the reviewers, give every finding one recorded outcome, fix, verify, push, resolve; contested findings go to an arbiter | [`drive-pr`](plugin/skills/drive-pr/README.md), [`resolve-review-comments`](plugin/skills/resolve-review-comments/README.md), the [`review-arbiter`](plugin/agents/review-arbiter.md) agent |
| 5 | Repair | Red CI or a conflict with the base: a bounded repair round, then check again | `drive-pr` with [`resolve-conflicts`](plugin/skills/resolve-conflicts/SKILL.md); [`fix-ci`](plugin/skills/fix-ci/SKILL.md) run on its own (the drive's CI repair does not use it yet, ROADMAP.md, Later) |
| 6 | Merge | A person merges | a person |
| 7 | Follow up | Deferred review findings become tracked follow-up items; the pull request lists every out-of-tree action merging leaves open | `resolve-review-comments`' deferral, `do-item` |

Follow-up items enter the line again at station 1, so the execution level is
itself a loop. `drive-pr` stops on one named end state (converged, waiting on
a person, conflicting, …) and never approves or merges. On the roadmap: a
converged drive arming the merge it certified (ROADMAP.md item 9, which
changes "a person merges" and is decided on its own), and a skill that runs
the post-merge stage [M7](modules/M7-pr-lifecycle-review/README.md) states,
which settles what a merge still owes beyond the follow-ups station 7 files
(item 17).

## The learning loop (wraps both)

Misses become lenses (see M8): a significant miss an automated step should
have caught gets classified, reconstructed as an eval fixture, and answered
with an additive check. The check gates only once validated on its fixtures,
and its recall, precision and cost decide whether it is kept, promoted or
removed, so both loops get sharper over time without growing manual
vigilance. Review outcomes are the measure's raw data: each reply that settles a thread opens with
its recorded outcome, so a reviewer's hits, false positives and declined
findings can be counted rather than guessed from the thread's prose, and
deferred findings return to the line as work items. Session reflections and promoted memories feed the same
scaffolding; the plugin's
[`promote-memory`](plugin/skills/promote-memory/SKILL.md) skill does the
promotion.

## What stays with a person

A factory that automates every station still leaves these decisions to people,
and Jig keeps them there:

- the intent: what to build, and each design stage's acceptance;
- the dilemmas `decide` escalates and the review findings a drive marks for a
  human decision;
- the merge (until a repository delegates it, roadmap item 9);
- promotion to production ([M10](modules/M10-environments-deploy/));
- changes to the scaffolding agents propose from their own sessions (M8).

## What Jig leaves to the platform

The machines, environments, deployment infrastructure and monitoring a factory
runs on are not Jig's. The modules state what the repository needs from them,
so any platform can supply it:

- **Parallel workspaces**: many agents on one machine without colliding
  ([M12](modules/M12-parallel-agent-ergonomics/)). The plugin is installed once
  per machine and needs no setup per workspace in Herdr, Conductor or any
  other tool that creates worktrees and starts sessions with the user's own
  agent configuration. A runner with its own configuration directory, a
  container, or a tool without plugin support needs the setup in
  [plugin/README.md § Where it works](plugin/README.md#where-it-works).
- **Environments and deployment**: verify what merged, ship only what was
  verified, promote by hand, disposable preview environments
  ([M10](modules/M10-environments-deploy/)).
- **Measurement**: the delivery process emits typed events with wired sources,
  so review quality, gate health and cycle time are measured rather than
  assumed ([M11](modules/M11-process-observability/)).
- **Supply chain**: third-party automation pinned and updated, application
  dependencies held back by a [release cooldown](GLOSSARY.md) and an
  [install-script allowlist](GLOSSARY.md), secrets scanned in layers, and
  reviewers wired so the change under review cannot alter them
  ([M1](modules/M1-gates-enforcement-ladder/), [M7](modules/M7-pr-lifecycle-review/)).
