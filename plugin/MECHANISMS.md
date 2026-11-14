# Where the model is in the loop: Jig's deterministic and reasoned parts

Some of Jig's parts are programs that run the same way every time. Others
are an AI model reading instructions and deciding. A team that adopts Jig
needs to know which is which. That tells it what it can trust without
reading it, what a model may change, and who notices when something breaks.
Without one page that says so, the line between the two is spread across
every skill's documentation and the code behind it. A reader then has to
trace the scripts to learn that the
[dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) runs with
no model in it, or that the drive ledger is written only by the driver.

This page maps Jig **by mechanism**. For each part it names the
[deterministic part](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
that owns it (the script, where its state lives, what it refuses), the
[reasoned parts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
that use it and what they are trusted to decide there, and who notices a
failure and who is asked to fix it. It is a view of the same
system: the
[lifecycle map](https://github.com/jig-harness/jig/blob/main/docs/LIFECYCLE.md)
walks it by stage, with the skill that owns each,
[FACTORY.md](https://github.com/jig-harness/jig/blob/main/FACTORY.md) walks it
by station, and [RECORDS.md](RECORDS.md) lists it by record: every file,
table, comment and label the parts below share, where it lives, who writes
it and what guards it.

**How paths are written.** A path in the plugin is written in full from the
plugin directory (`dispatch/lib/launches.ts`,
`skills/drive-pr/scripts/drive.ts`); once a section has given a file's full
path, or the folder a list of files sits in, it names those files by file
name. A path in Jig's own repository outside
the plugin starts with its top-level folder (`scripts/`, `modules/`,
`website/`, `.claude/`), none of which the plugin has. A path starting with
`~` or `.context/` is on the machine or in the working tree of the
repository being worked on.

Contents: [the two kinds of part](#the-two-kinds-of-part) ·
[when a model reads or writes Jig's code](#when-a-model-reads-or-writes-jigs-own-code) ·
[the map at a glance](#the-map-at-a-glance) ·
[each part](#each-part) ·
[the other skills](#the-other-skills) ·
[where the boundary rests on instructions](#where-the-boundary-rests-on-instructions)

## The two kinds of part

A **deterministic part** is a script with no model in it. Given the same
records it does the same thing, and when a record is missing or unreadable
it refuses or reports instead of guessing. Its state is a file on the
machine or a record on the forge (the code host, GitHub today) that another
script reads back. Examples: the gates, `jig dispatch` and `jig gc`,
`skills/drive-pr/scripts/drive.ts`, the tracker scripts, the release step.

A **reasoned part** is a model session working from a skill's instructions.
These are the reasoned parts Jig has:

- **A skill's session**: a person or the dispatcher starts `/jig:do-item`,
  `/jig:audit`, a follow-up command and the like, and the model follows its
  `SKILL.md`.
- **A drive pass**: one round of a
  [PR drive loop](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (a *drive*, run by [drive-pr](skills/drive-pr/README.md)). `drive.ts`
  starts each pass as a fresh agent process that gets one prompt and has no
  person at its terminal, for example
  `claude -p "/jig:drive-pr --bots-only <PR>"`. It triages, fixes,
  validates, commits and pushes (through
  `skills/drive-pr/scripts/finish-round.ts`), then ends.
- **An implementer**: the agent `do-item` hands the change to, chosen by its
  [route](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), with read-only
  [scouts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) sent ahead
  of it.
- **The [Review Arbiter](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)**:
  the [`review-arbiter`](agents/review-arbiter.md) agent, which rules on
  contested review findings. It is given only the `Read`, `Grep` and `Glob`
  tools, so it reads and never edits.
- **The review's semantic tier and its lenses**: the reviewers `/jig:review`
  runs over a diff.
- **The audit's judgement**: the scores the audit session gives every
  criterion no [probe](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  settles.
- **The steward's judgement**: an owner-host pass reads stopped work and the
  assigned queue and submits closed records through
  `skills/steward/scripts/steward.ts`. The next tick rechecks them under its
  launch guards and recovery budget. The model starts no launch and never
  answers a registry-class park; see [steward](skills/steward/README.md).

The two kinds meet in one pattern almost everywhere: **a model decides, and
a script writes the record.** A pass chooses a thread's outcome;
`skills/resolve-review-comments/scripts/reply-to-thread.ts` posts it, and
refuses a reply that does not open with one of the outcome words unless
the caller passes `--no-outcome`, which is for a reply that is not an
outcome, such as a clarifying question. `do-item` decides to take an item;
`skills/do-item/scripts/tracker.ts claim` writes the claim, and refuses an
item that someone else holds. So a model's decision reaches a shared record
through a script that checks it.

What a model may change, and what only a script changes:

| A model may change | Only a script changes |
|--------------------|-----------------------|
| the repository's code, tests and documents, on a branch | the drive's state, locks, leases and its ledger comment (`skills/drive-pr/scripts/drive.ts`, `skills/drive-pr/scripts/drive-state.ts`) |
| a review reply's outcome and its reason (posted by a script that checks it) | the push of a drive's round (`skills/drive-pr/scripts/finish-round.ts`, `skills/drive-pr/scripts/guarded-push.ts`) |
| a change note, a decision record, an issue body | the dispatcher's launch records, walls, receipts and outcome log |
| an audit score where no probe decides | the follow-up marker, once claimed (`jig dispatch marker`) |
| a directive in a drive's mailbox, from the session that armed it; an answer to a question a drive [parked](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), when the model is the person's own session | the changelog's release sections, the plugin version and the tags (the release step) |

The right-hand column is protected by different things: some of it by the
forge, some by checks, and some only by the instructions every skill
follows.
[Where the boundary rests on instructions](#where-the-boundary-rests-on-instructions)
lists the parts that only the instructions protect.

## When a model reads or writes Jig's own code

**At run time, never by design.** In a repository that uses Jig, the
programs that run with nobody at the keyboard are deterministic: the
dispatcher's [tick](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`dispatch/tick.ts`) and the wrapper every session it starts runs in
(`dispatch/run.ts`), resource collection (`jig gc`), the launcher the
scheduled jobs run (`runtime/launcher.ts`), and the drive's loop control
(`skills/drive-pr/scripts/drive.ts`). They start sessions and read how they
ended. The only reasoning is inside the sessions they start: a drive pass,
a pickup's `do-item` session, a follow-up pass. Those sessions read
Jig's `SKILL.md` files and run Jig's scripts, but what they write is the
repository's own code, replies and records. The plugin they run is an
installed copy, and a change to it reaches a machine only as a released
version ([releases](README.md#releases)).

**In the repository's own work, a model writes the code.** What a session
writes in a repository that uses Jig is that repository's code and records,
and it is held to that repository's gates, review rounds and a person's
merge. A defect in one of Jig's scripts is a change to Jig, shipped as a
version. How Jig itself is developed, and what its own changes must pass, is
in [CONTRIBUTING.md](https://github.com/jig-harness/jig/blob/main/CONTRIBUTING.md).

## The map at a glance

One row per part. "Noticed by" is the first thing that sees a failure;
"asked to fix" is who gets the work. A defect in a script itself is always a
change to Jig, made by an implementer or a drive pass during Jig's
development and shipped as a version.

| Part | Deterministic owner | Reasoned users, and when | Failure noticed by | Asked to fix |
|------|---------------------|--------------------------|--------------------|--------------|
| [Gates](#gates-and-the-validation-plan) | `gates.command`; CI | implementer before the push; drive pass every round | the session that ran them; CI's required check | the session whose change failed them |
| [Change areas](#gates-and-the-validation-plan) | `skills/change-areas/scripts/` | review, drive pass, fix-ci, through the plan | the session that read the plan (exit 2) | whoever maintains the catalog |
| [`jig` command and timers](#the-jig-command-and-its-timers) | `jig.ts`, `runtime/verbs.ts`, `gc/install.ts`, `dispatch/install.ts`, `runtime/launcher.ts`, `runtime/upgrade.ts`, `runtime/scheduled-upgrade.ts`, `runtime/upgrade-record.ts`, `runtime/doctor.ts` | none | `jig doctor`; the jobs' receipts; the scheduler's own log; a person | a Jig change |
| [Resource collection](#resource-collection-jig-gc) | `gc/` | none | its receipts (`jig receipts gc`) | a person; a Jig change |
| [Dispatcher's tick](#the-dispatchers-tick) | `dispatch/tick.ts`, `dispatch/run.ts` | the sessions it starts | its receipt; the morning report | a person; a Jig change |
| [Dispatcher's records](#the-dispatchers-records-receipts-outcome-log-dashboard-notifications) | `dispatch/receipts.ts`, `dispatch/lib/log.ts`, `dispatch/dashboard.ts`, `dispatch/lib/notices.ts` | a dispatched session records its result | the dashboard; the morning report | a person, through `/jig:reflect` |
| [Follow-up marker](#the-follow-up-marker) | `dispatch/marker.ts`, `dispatch/lib/followup-marker.ts`, `shared/records/shared-forge.ts` | the follow-up session | the follow-up session (exit 1, 2 or 3) | a person deletes or marks the marker |
| [Shared records](#shared-records-several-hosts-on-one-repository) | `shared/records/shared.ts`, `shared/records/shared-forge.ts`, `dispatch/lib/shared-launches.ts`, `dispatch/run.ts` | none | the wrapper's output; the tick's report and receipt | a person (a claim to delete, an `owner` to set); a Jig change |
| [The drive](#the-drive-driver-locks-leases-ledger) | `skills/drive-pr/scripts/drive.ts` and its libraries | drive passes; the session that arms it | its exit state; the dispatcher; the morning report | the dispatcher re-arms mechanical stops; a person the rest |
| [Steering a drive](#steering-a-running-drive-the-mailbox-and-the-ci-hold) | `skills/drive-pr/scripts/mailbox.ts`, `skills/drive-pr/scripts/ci-hold.ts` | the session that armed the drive; a person | `guarded-push.ts`'s exit 17; the drive's exit 18, 19 or 1 | the sender resumes the directive; a person removes a leftover label |
| [Review threads](#review-threads-and-the-arbiter) | `skills/resolve-review-comments/scripts/` | drive pass; the arbiter | the pass (non-zero exit), then `drive.ts` | the next pass, or a person on a park |
| [Review and lenses](#review-and-lenses) | `skills/review/scripts/` | review's semantic tier and lens reviewers | the reviewing session (exit 2) | the session, or the repository's lens owner |
| [Tracker and forge](#the-tracker-and-the-forge) | `skills/do-item/scripts/tracker.ts` and its adapters; `gh` under deadlines | every skill that files, reads or claims | the calling session (exit 1 or 2, or the failure class's own, 5 to 11); the tick's report | a person (credentials); a Jig change (an adapter) |
| [Pickup](#pickup-claim-routing-pull-request-plan-intent-chain) | `do-item`'s claim, routing, pull-request plan and intent chain scripts | the `do-item` session; its implementer | the `do-item` session | the session stops and says why; a person |
| [Conflicts and CI repair](#conflicts-and-ci-repair) | `skills/resolve-conflicts/scripts/`, `skills/fix-ci/scripts/` | the drive's repair rounds; a person's session | the check before the merge concludes; CI | the pass or session repairing |
| [Changelog and release](#the-changelog-and-the-release) | `skills/changelog/scripts/`, the release workflow | implementer writes the note; the pass keeps it true | the changelog check; the release run; the follow-up | the session that wrote the note; a person for the release |
| [Hooks](#hooks) | `hooks/turn-budget-guard.ts` | every session (it acts on them) | the session (a hook error) | a Jig change |
| [The audit](#the-audit-probes-and-judgement) | `skills/audit/scripts/` | the audit session's judgement | `record.ts check`; Jig's audit-fit gate | the audit session |
| [Decisions, documents, reflection](#decisions-documents-and-reflection) | the `decide`, `adr`, `docs`, `reflect` and `review-reflections` scripts | the skills' sessions | the session (non-zero exit); the docs gates | the session; a person approves |
| [The other skills](#the-other-skills) | each skill's `scripts/`, where it has one | the skill's session | the session | the session |
| [Jig's own site and post-merge pass](#in-jigs-own-repository-the-site-and-the-post-merge-pass) | the site build and deploy workflow, `scripts/website-sync.ts` | follow-up and site-update sessions | the deploy run; the follow-up's website arm | the follow-up session, in a follow-up pull request |

## Each part

### Gates and the validation plan

- **Deterministic.** The repository's gate command (`gates.command` in its
  configuration, [CONFIGURATION.md § gates](CONFIGURATION.md#gates)) and CI,
  which is the authority. A drive validates each round by the
  [validation plan](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
  `drive.validation_plan_command` reads the changed files and prints the
  checks they owe, and without one the plan is the gate command alone.
  `skills/change-areas/scripts/resolve.ts` prints such a plan from the
  repository's
  [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  and `skills/change-areas/scripts/check.ts` checks the catalog itself. No
  state of its own beyond the catalog file. Refuses: a failing check fails
  the run; the catalog check exits 2 on a schema error.
- **Reasoned.** The implementer runs the gates before the first push; a drive
  pass runs the plan on the cumulative tree every round and does not push
  until it passes; `fix-ci` reads a red run. They decide how to fix what
  failed, never whether a failure counts.
- **Boundary.** A model changes the code until the checks pass; it does not
  change the gates' verdict. A drive has no path that skips the repository's
  hooks or the plan (there is no `--no-verify` path,
  [drive-pr § What it will never do](skills/drive-pr/README.md#what-it-will-never-do)).
- **If it fails.** The session that ran the check sees it first; on a pull
  request, CI's required check does, and the drive's repair round takes it.
  The session whose change failed the check fixes it. A broken gate is a
  change to the repository that owns it.

### The `jig` command and its timers

- **Deterministic.** `jig.ts` is one command-line parser over the
  components (`gc/component.ts`, `dispatch/component.ts`), each
  implementing `runtime/component.ts`; it refuses a malformed command line
  with exit 2. The lifecycle verbs (`runtime/verbs.ts`) reach the
  components only through that interface. `jig install` prints each
  scheduled job first and writes it only with `--yes`: a systemd user
  timer, a launchd job or a crontab line (`runtime/scheduler.ts`), and the
  `jig` command, `~/.local/bin/jig` (`runtime/path-command.ts`). Each job
  runs a launcher copied under its own state folder,
  `~/.local/state/jig/gc/launcher/` for collection and
  `~/.local/state/jig/dispatch/launcher/` for the dispatcher
  (`runtime/scheduler.ts` joins the job's state root, which
  `dispatch/install.ts` sets for the dispatcher's job), and the `jig`
  command runs its own copy under `~/.local/state/jig/launcher/`. At each
  run the launcher asks the agent tool (`claude plugin list --json` or
  `codex plugin list --json`) for the installed plugin copy, so an update
  reaches the job and the command without a new install
  (`runtime/launcher.ts`). It refuses to run a script that lives inside a git
  checkout, which a worktree cleanup could remove. `jig upgrade` has each
  agent tool update the plugin on the channel it follows
  (`runtime/harness.ts`), printing each command first, then runs the newly
  installed copy's `jig upgrade --jobs-only`, which refreshes each job's
  launcher copy and rewrites the job from what it holds, keeping its
  environment, schedule and programs, and the `jig` command the same way
  (`runtime/refresh.ts`, `runtime/installed-job.ts`). It writes nothing
  where nothing differs. A tool that updates the plugin on its own
  ([automatic updates](README.md#automatic-updates)) leaves the launcher
  copies as they were. Before `gc --scheduled` and `dispatch --apply`, the
  launcher runs the installed copy's `jig upgrade --scheduled` under its own deadline, then
  asks the agent tool again which copy is installed and runs the job on it;
  whatever the upgrade came to, the job runs, and gets the upgrade's line
  for its receipt in `JIG_SCHEDULED_UPGRADE`. The `jig` command's script and
  a woken tick mark their launches (`JIG_LAUNCHER_ROLE`) and do not upgrade,
  and the dispatcher's change probe, run every minute, does not either.
  `jig upgrade --scheduled` (`runtime/scheduled-upgrade.ts`) reads the user
  file's `upgrade` setting, withholds the upgrade on a machine that opted
  out, takes the interval under a file lock (`shared/file-lock.ts`) by
  writing a stamp naming its process (`runtime/upgrade-stamp.ts`) unless the
  latest one is younger than `upgrade.every` (an attempt whose process
  died counting as a failed one) or names a process still running it, withholds it for a harness pinned to a tag or ref, skips
  a plugin loaded in place from a local folder, and otherwise runs the same
  update and refresh as `jig upgrade`, leaving a loaded launchd job's file
  alone. `jig doctor` (`runtime/doctor.ts`) checks Bun, the
  agent tools, the plugin in each tool, each launcher copy, the latest
  scheduled upgrade, the programs
  each job names, each component's own needs (`Component.doctor`), the
  last receipts and the repository's configuration fit, and names a fix for
  each failure; it changes nothing. `jig ask` (`ask/cli.ts`), registered
  beside the components with no job of its own (`CommandComponent`), reads
  a station's records through their owners' exports and prints one answer;
  it writes no record. `jig send` (`send/cli.ts`), registered the same way,
  reads the station through `jig ask`'s readers, refuses a request it cannot
  take, and writes one record through the writer its owner exports.
- **Reasoned.** None. A person installs and checks, a person or a timer
  upgrades; no session is involved.
- **If it fails.** A job that cannot find the installed copy stops with a
  message naming what to run; the scheduler's own log holds it, and
  `jig doctor` names the check that fails and its fix. A person reads it.
  A defect is a Jig change.

### Resource collection (`jig gc`)

- **Deterministic.** `gc/` inventories the leftovers a repository declares
  (scratch folders, tool state, worktrees) and reports, with the evidence,
  which of them it could collect ([resource collection](gc/README.md)).
  Scratch folders and tool state are report-only: collection stays off for
  each until every process that creates them takes part in its admission
  protocol. A worktree Orca manages is eligible for collection when the machine entry
  names Orca's command, and an eligible one is removed only in a collecting
  run (`--collect`, or `--scheduled` on the configured weekday or under disk pressure) once its proof of death
  holds; an ordinary run reports it as `would-collect` and removes nothing.
  Orca's registry stands in for the admission the opener does not hold, the
  base branch's copy of the remove hook runs, the unsent reflection findings
  are parked, and `orca worktree rm` removes it
  ([worktrees Orca manages](gc/README.md#worktrees-orca-manages)), under an
  admission in the [launch guard record](gc/README.md#the-launch-guard-record)
  that Jig's plugin for Orca reads to refuse launches into it; every
  other worktree is reported. It also removes its own receipts past their
  retention. State: one receipt per run under `~/.local/state/jig/gc/<date>/`. Refuses: an
  unreadable process identity or forge answer keeps the resource, and an
  abandoned admission token blocks collection rather than being taken over.
  Each admission token holds its creator's
  [process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`shared/liveness.ts`), and the refusal names a stale one's creator and why
  it counts as gone, for a person to remove.
- **Reasoned.** None. Sessions only take part as owners: a scratch creator
  holds shared admission while it creates its folder (`shared/gc-lock.ts`).
- **If it fails.** Exit 1 and a receipt that records the failure.
  Nothing notifies anyone: a person reads `jig receipts gc`. A defect is a
  Jig change.

### The dispatcher's tick

- **Deterministic.** `dispatch/tick.ts`, run every interval by the timer
  `jig install dispatch` writes. Under a lock it reads, for each
  repository, the `dispatch` section from the default branch, the tracker,
  the open pull requests and their drive ledgers, and the session runtime's
  sessions; it plans what is wanted and not running, and with `--apply`
  starts what the machine file enables ([the dispatcher](README.md#the-dispatcher)).
  State, under `~/.local/state/jig/dispatch/`: a
  [launch record](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) per
  session (`dispatch/lib/launches.ts`, written before the launch, so a lost
  launch still holds its slot), each account's usage-limit
  [walls](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`dispatch/lib/walls.ts`), and follow-up outcomes
  (`dispatch/lib/followup-outcomes.ts`). Every session it starts runs in the
  wrapper `dispatch/run.ts`, which claims its launch record once and binds
  the session to the admitted account: for a drive it starts
  `skills/drive-pr/scripts/drive.ts`, whose passes run with no person at a
  terminal, and writes the account's wall on a usage-limit
  stop (`QUOTA_PARKED`, exit 16); for a follow-up it starts the account's agent as a
  headless pass on the follow-up command, with the host's `drive.pass_args`
  (a Codex account's: `drive.codex_bypass` and `drive.codex_pass_args`, as
  the launch record keeps them) and under the pass deadline; for a pickup it starts the account's agent
  as a headless pass on `/jig:do-item <key>` (or `work-batch` for a served
  batch), keeping its served-person claim context. It records the exit
  every way, with the last question of a follow-up pass that stopped short
  of done, and then writes a drive's or a follow-up's end onto the
  [shared claim](#shared-records-several-hosts-on-one-repository) the tick
  made for its launch. The claim is the wrapper's
  [process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  recorded and judged by `shared/liveness.ts`: a record claimed on this host
  before it last restarted has died, and its outcome row says so; one claimed
  on another host, or whose process table cannot be read, is unknown and
  holds its slot until a person clears it. Refuses: a record it cannot read
  or a target it cannot place is reported and never planned; an account
  whose configuration directory does not resolve to the identity the
  machine file names starts nothing (`dispatch/lib/accounts.ts`); a launch
  record already claimed is not started twice (exit 3). A pickup's claim
  is the session's own write (`dispatch/lib/actions/pickup.ts`), not the
  tick's; the tick also writes steward-approved facets and the
  blocked-state projection below. It names each workspace it creates
  and each tab it opens as the dispatcher's, and keeps the
  [dispatched mark](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  in the workspace's comment and on the launch record, by one convention
  every runtime takes (`dispatch/lib/runtime/port.ts`). The wrapper, the
  launch records, the outcome log and the ledger classifier read every exit
  of a drive by its name in drive-pr's terminal-state registry
  (`skills/drive-pr/scripts/lib/status/terminal-states.ts`'s `DRIVE_EXIT` and
  the sets beside it), never as a number of their own, and the registry's
  consistency test fails a dispatcher file that restates one. Where a repository turns
  [pull request state labels](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  on, the tick reads the pull requests' labels with them, reads `drive`
  and `hold` as a person's commands, and last sets each managed pull
  request's state label from its ledger, re-reading the ledger just before
  a write and skipping one whose ledger changed since the tick read it
  (`dispatch/lib/actions/labels.ts`, `dispatch/lib/label-freshness.ts`); it
  never reads a state label to decide what to start. The mapping from a
  ledger to its state label is one projection in shared code
  (`shared/pr-labels/`), which the drive (`drive-pr`'s
  `scripts/lib/driver/state-labels.ts`) and the follow-up
  (`dispatch/lib/followup-label.ts`) write through too, each when what it
  owns changes. Where a repository names a `blocked` tracker state, the
  drive and the tick also move the items a pull request links to and out
  of it from the same projection (`shared/pr-labels/blocked.ts` decides,
  `do-item/scripts/lib/blocked-move.ts` writes, `dispatch/lib/actions/blocked.ts`
  at the tick), each item read, and written only where it disagrees. Where a repository turns its
  [adoption rule](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  on, the tick arms a pull request with no ledger that the rule's author
  and window match as it arms a labelled one (`dispatch/lib/adopt.ts`).
- **Reasoned.** None inside the tick. It starts reasoned parts: a drive's
  passes (through `drive.ts`), a pickup's `/jig:do-item` session, and the
  repository's `dispatch.followup_command`. Its one keystroke into a
  session is the fixed nudge after a usage limit resets; every other stuck
  state becomes a notification.
- **Boundary.** Because it reads the `dispatch` section from the default
  branch, a change a model makes on a branch reaches the dispatcher only
  once a person has merged it. A `drive` label starts a drive and a `hold`
  label stops every stage: the tick does not check who added either, so
  whoever the forge lets label pull requests (on GitHub, triage access or
  more, a workflow's token included) can give these commands.
- **If it fails.** The receipt records what it could not read, and the
  [morning report](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`skills/drive-pr/scripts/drives.ts --report`) lists launches it refused
  or lost. No agent watches the tick: a person reads these. A defect is a
  Jig change.

### The dispatcher's records: receipts, outcome log, dashboard, notifications

- **Deterministic.** A receipt per tick under
  `~/.local/state/jig/dispatch/receipts/` with what it read and planned,
  kept 30 days unless the machine file says otherwise
  (`dispatch/receipts.ts`). Its tracker record says where the tracker
  keeps each item's type, priority and size and why, whether detection
  answered from its cache, and which assigned items lack one, by key; that
  read is bounded by the tick's deadline, and one that fails or is stopped
  is a line of the record, never a reason to skip the pickups
  (`dispatch/lib/sources/tracker-facets.ts`). The
  [outcome log](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), one
  row per ended launch and one event row per observed cause, in
  `log-<year>-<month>.jsonl`, which nothing removes (`dispatch/lib/log.ts`);
  a stop no class fits is logged as `unknown`, never dropped. The dashboard
  (`dispatch/dashboard.ts`) reads the log and the line the newest tick left in
  the state database (`dispatch/lib/line.ts`), and writes nothing; it listens
  only on a private or loopback address and refuses a request without its token.
  A notification is a note on the workspace the session runtime shows a
  person (with Orca, the workspace's comment). It counts as sent only when
  that note, read back, carries the message's key line. While its cause
  stands, it is sent again after `dispatch.renotify_after` unless it is
  still unread; `0s` sends each cause once (`dispatch/lib/notices.ts`).
  What fails in a row (a label write, a notice's delivery, a nudge, a
  claim end or marker answer, a repository's turn, the tick) is counted in
  the failure ledger (`dispatch/lib/failures.ts`): an action backs off
  from its second failure in a row, and a row at `failures.notify_after`
  failures is notified once, then on the same cadence; a success or the
  action leaving the plan removes it.
- **Reasoned.** A dispatched interactive session records how it ended with
  `jig dispatch result <record> <token> done|failed` (`dispatch/result.ts`).
  That answer is the session's own judgement; the script refuses another
  record's token, a drive pass's record and a second answer. Its closing
  report, the last act of a pickup's, a follow-up's or the steward's
  pass, goes through `jig dispatch report <record> <token> <file>`
  (`dispatch/report-command.ts`), which redacts and checks it
  (`shared/closing-report.ts`) and keeps the last one that passes beside
  the result, never touching it. Nothing
  else reasoned writes these records. A completed pickup names its pull
  request with `--pr <number>`, or `--none "<reason>"` when none was needed;
  a pickup the tracker's rate limit stopped before it claimed the item
  records `waits --until <time>`, and the tick starts it again after that
  time; after the claim the pass waits within its deadline or records
  `failed`. A follow-up pass that meets the forge's or a tracker's rate
  limit records `waits --until <time>` too: its marker stays until then,
  the tick releases it after the reset and a later tick starts the
  follow-up again, and the third wait in a row is notified
  (`dispatch/lib/followup-waits.ts`).
  A pickup whose claim the repository's start rules refused records
  `failed --refused <updated-at> --reason <reason>`: the tick holds the item, showing
  the reason, until its `updatedAt` moves past that time. A batch pickup adds
  `--key <item>` beside each `--refused`, once per refused member: only those
  members are held, each on its own `updatedAt`, and the rest of the batch is
  picked up again without them.
  The answer and its next owner are written together. An ended launch's
  outcome keeps that handoff, deriving it where the line fixes it; `jig ask`
  prints it as `last.next`.
- **Boundary.** The tick tunes none of its own settings. A class that keeps
  recurring is a finding: where reflection is on, the tick records it, once
  a week, as a finding about the dispatcher in the reflection store
  (`dispatch/lib/reflection-route.ts`), and otherwise a person records it with
  [`/jig:reflect`](skills/reflect/README.md). A person approves any change
  through [`/jig:review-reflections`](skills/review-reflections/README.md).
- **If it fails.** A person, from the dashboard or the morning report. Asked
  to fix: a person decides the change; a defect is a Jig change.

### The follow-up marker

- **Deterministic.** The
  [follow-up marker](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), a
  hidden-marker comment on a merged pull request, claims its follow-up
  (`dispatch/lib/followup-marker.ts`). It is the follow-up stage's
  [shared record](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  written and read through `shared/records/shared-forge.ts`, and a
  [forge claim](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) of
  the shared module `shared/records/forge-claims.ts`, which posts it, reads
  it back (again a few times while the listing does not show it yet) and
  decides it by the claims' one rule. The tick posts one naming its launch
  record and its host before it starts the session; the wrapper writes the
  follow-up's answer onto it when the pass ends, and the next tick writes
  it where the wrapper could not. A run by hand uses
  `jig dispatch marker claim`, `check` before each act outside the pull
  request, and `done` at the end (`dispatch/marker.ts`). A marker counts only
  when the dispatcher's own login or an owner, member or collaborator wrote
  it. Of two trusted markers the commands stand down for the earlier
  comment; the dispatcher instead reports a conflict, naming the earlier,
  and plans no follow-up until a person settles the duplicate
  (`dispatch/lib/plan-followups.ts`). A claim no run will finish (a person's
  not marked done, or another host's with no answer, past
  `dispatch.followup_stale_after` with no session joined to its pull request)
  the owner host deletes once per pull request, recorded in its state
  database (`dispatch/lib/actions/release-claims.ts`), and notifies a person
  when a claim on it goes stale again. Refuses: exit 3 when an earlier marker
  holds the follow-up, exit 2 for a comment that is not a trusted marker,
  exit 1 when the markers cannot be read or the read-back never lists the
  marker it posted.
- **Reasoned.** The follow-up session decides what the merge still owes and
  does it; it calls the marker commands at the points its instructions name.
- **If it fails.** The follow-up session stops on any non-zero exit. A
  follow-up of this host's that stopped on a routine question (`local-leftover`,
  `person-owed` or `drafted-items`, the classes in
  `dispatch/lib/routine-questions.ts`) is run once more with the class's
  standing answer
  ([`repositories[].stages`](CONFIGURATION.md#dispatch)), when that run
  again fits the pull request's recovery budget and its attempt was not
  itself a run again; one that failed before questions were tagged runs
  again with every class's standing answer, from its launch record while that
  is still on this host or from the retry evidence kept with its outcome
  (`dispatch/lib/routine-reruns.ts`). A failure that does not
  qualify (another host's marker, a question that is not routine or does
  not read, an attempt that was itself a run again) is notified as a need on
  the configured cadence and not started again until a person answers
  it: **Run it again** deletes its marker, so a later tick starts it again
  with the person's note in its prompt, and **Record it done** marks the
  marker done in place and sets the pull request's followed-up label, so
  nothing runs again ([Every need is a decision](README.md#every-need-is-a-decision)).

### Shared records: several hosts on one repository

- **Deterministic.** A repository may be dispatched by several hosts, each
  listing it in its own machine file. Before a drive's launch the tick posts
  a launch claim on the pull request beside its launch record, through the
  `SharedRecords` interface (`shared/records/shared.ts`), whose forge
  implementation (`shared/records/shared-forge.ts`) posts it as a
  [forge claim](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) on
  the attempt after the latest and reads it back; the follow-up marker is the
  follow-up's. A launch's end reaches its claim after the launch ends and
  any explicit rearm request's label removal is acknowledged. Until then
  the open claim reserves the delivered request across hosts, including
  when only the wrapper's claim proves delivery after a lost runtime receipt.
  The wrapper `dispatch/run.ts` writes the end after it records the stage's
  exit, each forge call under a short deadline. The host's next
  `--apply` run is the backstop: it writes the end of every claim of its own
  whose launch record ended and still has none (a wrapper killed before its
  write, a forge that refused it; `dispatch/lib/shared-launches.ts`). Every
  run reads every host's claims beside its own launch records, and the
  receipt records each read and write and the forge budget left. Refuses: a
  launch another host's current claim with no end holds (reported as held by
  that host), a launch whose claim loses its attempt (withdrawn, the launch
  record given back), and a pull request whose claims do not read
  (unplaced). A takeover of a driver another host started needs its ledger's
  heartbeat past the lease window, never a claim alone. One host owns each
  repository (`owner` in the machine file): only it notifies, writes the
  dispatch labels and writes outcome-log rows for what it did not launch.
- **Reasoned.** None. The claims coordinate launches and never authorize an
  act a person takes.
- **Boundary.** The forge offers no conditional create for a comment, so two
  hosts whose read-backs both lag can each read themselves the holder of one
  launch; the stage's own refusal (the drive's lock and ledger claim,
  `do-item`'s claim, a follow-up's re-check before each act) is the
  backstop.
- **If it fails.** An end the wrapper could not write is one line on its
  output, and the next tick writes it. A claim whose host never writes its
  end holds its pull request until a person deletes the comment; a forge that
  cannot be read leaves the pull request unplaced for the tick. A defect is a
  Jig change.

### The drive: driver, locks, leases, ledger

- **Deterministic.** `skills/drive-pr/scripts/drive.ts` is the loop
  control: it starts one pass per round, reads the result, and stops in
  exactly one [terminal state](skills/drive-pr/README.md#the-exit-states--what-you-do-now)
  with its exit code. Its machine state lives in one SQLite database per
  machine, `~/.local/state/jig/drive-pr/state.sqlite`
  (`skills/drive-pr/scripts/lib/state/db.ts`, opened through
  `shared/records/db.ts`), every row keyed by the clone: the verified head,
  parked and held items as one JSON document per pull request, the review
  round record (`review_rounds`, `skills/drive-pr/scripts/lib/state/review-rounds.ts`),
  one row per head counted, which a hand-driven review loop counts into too,
  so the drive's rounds, its ledger and `current-round.ts` read one number, and
  the locks, [leases](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  and claims as rows. A lock or lease names its holder by the shared
  [process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`shared/liveness.ts`), whose host id is compared before the host name, so
  a renamed machine still knows its own driver, and a lock whose holder is
  judged dead is recovered at once; a release deletes the row and leaves
  nothing behind. A lease's generation only grows, so a command admitted on
  one generation is refused at the moment it mutates once another session
  took the lease. The clone's folder beside the database,
  `~/.local/state/jig/drive-pr/<clone>/`, keeps the driver log and the
  files a pass is handed; a folder an earlier release wrote is read into the
  database once, at its first open, and left in place. The
  [drive ledger](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  mirrors its resumable part as one comment on the pull request, written by
  the driver at each round boundary, park,
  [takeover](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (another
  driver claiming a drive whose driver has stopped answering) and stop
  (`skills/drive-pr/scripts/lib/state/ledger.ts`,
  `skills/drive-pr/scripts/lib/state/ledger-forge.ts`); a ledger counts only
  when the drive's own login or an owner, member or collaborator wrote it.
  A takeover is a
  [forge claim](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  read back and decided by `shared/records/forge-claims.ts`: per ledger
  generation the earliest trusted claim wins, with the lease window as its
  lapse window. So is the merge-ready announcement
  (`skills/drive-pr/scripts/announce-merge-ready.ts`, through
  `skills/drive-pr/scripts/lib/announce.ts`): one per pull request and head,
  posted only while the head's merge readiness holds, and of two the earlier
  stands and the later is withdrawn.
  A round's finish is one script,
  `skills/drive-pr/scripts/finish-round.ts`, which sequences the CI hold,
  the push (`skills/drive-pr/scripts/guarded-push.ts`, which re-checks the
  pull request is still open at the moment it pushes), the head-sync wait,
  and resolving each held thread. Refuses: a second drive of the same pull
  request from this clone (exit 11) or while the ledger names a running
  driver elsewhere (exit 13); a push while a thread on a touched file is not
  fully triaged (`finish-round.ts` exit 7); a post from a pass whose lease
  was revoked (`skills/drive-pr/scripts/assert-post-allowed.ts`); a ledger
  version it cannot read (exit 1).
- **Answers to parked decisions.** One parser reads whole-comment
  `approve` and `choose <option>` answers and their notes for re-arm, the
  dispatcher, `jig ask` and `jig send`. It uses each person's latest edit,
  keeps other text as a free answer, and leaves conflicting choices or
  notes disputed. Any person's answer prevents a provisional decision.
- **Reasoned.** Each pass decides, for every finding, its outcome and its
  fix, at the repository's
  [autonomy level](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  ([drive-pr § Autonomy](skills/drive-pr/SKILL.md#autonomy-what-the-pass-decides-without-a-person)).
  It parks what only a person decides, and parks only under the registry's
  classes. It changes drive state only through
  `skills/drive-pr/scripts/drive-state.ts`, behind its lease. The session
  that arms a drive (`skills/drive-pr/scripts/arm-drive.ts`, from `do-item`
  or a person) decides when to start it.
- **Boundary.** The drive never merges, approves or requests changes, and
  never resolves an accepted thread before its fix is verified on the
  remote head ([drive-pr § What it will never do](skills/drive-pr/README.md#what-it-will-never-do)).
- **If it fails.** The exit state says what happened. `INDETERMINATE`
  (exit 1) asks the caller to run it again. The dispatcher re-arms a drive
  stopped on a usage limit or an answered park, and notifies a person about
  every stop only a person settles. The morning report lists each drive. A
  defect in the driver is a Jig change.

### Steering a running drive: the mailbox and the CI hold

- **Deterministic.** The
  [drive mailbox](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is a
  pair of append-only files under `.context/drive-mailbox/`, written through
  `skills/drive-pr/scripts/mailbox.ts`: any sender appends to the inbox, and
  only the driver appends to the outbox. Its directives are enforced
  by scripts, not by the pass:
  `hold-push` makes `skills/drive-pr/scripts/guarded-push.ts` refuse the push (exit 17, which a
  later round recovers from), and `skills/drive-pr/scripts/push-hold-recheck.ts`,
  where the repository runs it last in its pre-push hook, catches a hold
  sent while that hook runs; `pause` holds the driver at its next check,
  and ends it with exit 19 after `DRIVE_PR_PAUSE_MAX_SEC` (30 minutes by
  default); `stop` ends it at the next round boundary with exit 18. A `stop`
  may name a driver generation, the number each driver draws at its start,
  prints and carries in its lock's claim (`skills/drive-pr/scripts/lib/state/mailbox-stop.ts`):
  it ends that driver alone, and a later driver ignores it; a `stop` naming
  none ends every later driver in the tree until `resume --target stop`.
  `skills/drive-pr/scripts/drives.ts --stop` is a send of the same directive,
  addressed to the live driver's generation and marked `now`: the driver
  reads its mailbox for it every quarter second and cancels its active pass
  at once. The driver appends an `ack` of each directive it acted on to the
  outbox, so a sender sees it took effect. An
  unreadable mailbox stops the drive with exit 1. The
  [CI hold](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is a label
  (`ci.hold_label`) the drive puts on the pull request between rounds so
  the repository's workflows skip their expensive jobs;
  `skills/drive-pr/scripts/ci-hold.ts` adds and removes it, using the
  label's own timeline event as the proof that the drive, not someone
  else, made the change it undoes.
- **Reasoned.** The session that armed a drive, or a person, sends a
  directive or a note; a pass may read the notes (`mailbox.ts check`), and
  they never change what a round does. No reasoned part touches the CI hold
  label.
- **If it fails.** The drive's exit names the directive, and the outbox its
  `ack`. A `pause`, or a `stop` naming no generation, is resumed by whoever
  sent it (`resume --target <directive>`) before the drive is re-armed; a
  `stop` addressed to one generation needs nothing. A
  drive that stopped can leave the CI hold label behind; a person removes
  it by hand.

### Review threads and the arbiter

- **Deterministic.** The thread scripts in
  `skills/resolve-review-comments/scripts/`: `list-unresolved-threads.ts`
  reads them; `reply-to-thread.ts` posts a reply in the thread and refuses
  one that does not open with an outcome word, except under
  `--no-outcome`; `resolve-thread.ts` resolves a thread by its id;
  `triage-ladder.ts` gives the mechanical verdict on a finding against the
  [decline ladder](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md);
  `file-deferred.ts` files the findings a pull request deferred through the
  tracker adapter, reusing an issue already filed for the same entry.
  `converge.ts` repeats passes when no drive runs.
- **Reasoned.** The pass (or a person's session) reads each finding and
  chooses its outcome. Findings the rubric and the ladder do not settle go
  to the [review arbiter](agents/review-arbiter.md), which rules
  (fix now, rejected, won't fix, defer, escalate) and edits nothing.
- **Boundary.** A comment counts as a person's answer to a thread or to a
  parked question only when GitHub reports its author as an owner, member
  or collaborator (`shared/trusted-authors.ts`), whatever the comment says.
- **If it fails.** The pass sees the script's non-zero exit and stops or
  parks; `skills/drive-pr/scripts/drive.ts` reads the round's outcome. The next pass, or a person on
  a park, carries it on.

### Review and lenses

- **Deterministic.** `skills/review/scripts/`: `review.ts` sets up the
  review from the base branch's snapshot, so the change under review cannot
  rewrite the policy it is judged by; `effective-diff.ts` reads the diff
  with every git setting that could hide an edit fixed on the command line;
  `select-lenses.ts` chooses the
  [review lenses](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) a
  change triggers and reports a lens file the change adds as `proposed`,
  never run; `lens-verdict.ts` caps every lens finding at a warning, and one
  without evidence at information. Refuses: a mistyped lens id or pattern
  exits 2.
- **Reasoned.** The review's semantic tier and each selected lens's
  reviewer read the diff and report findings. `do-item` runs the same tiers
  before the first push.
- **If it fails.** The reviewing session stops on exit 2 and says why. The
  session fixes its call, or the repository's owner of the lens fixes the
  lens.

### The tracker and the forge

- **Deterministic.** Almost every skill reaches the issue tracker through
  `skills/do-item/scripts/tracker.ts` and the
  [tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  behind it (`skills/do-item/scripts/lib/tracker/`, with adapters for GitHub
  Issues, Linear and Jira); `skills/do-item/scripts/get_issue.ts` and
  `skills/do-item/scripts/list_comments.ts` read through the same interface.
  The forge is GitHub, reached through the signed-in `gh` client: each drive
  and dispatcher call goes through `ghCall` with a deadline
  (`skills/drive-pr/scripts/lib/proc.ts`), and the dispatcher's reads either
  answer in full or throw, so a population read in part is never planned
  from (`dispatch/lib/forge.ts`). Refuses: `get_issue.ts` exits 2 when the
  tracker cannot be reached; `list_comments.ts` never prints a partial list. One exception: the deferral step's batching
  script (`skills/resolve-review-comments/scripts/defer-batch.ts`) files on
  Linear directly, so choosing GitHub Issues or Jira does not redirect it
  until deferral moves onto the interface.
- **Reasoned.** `file-issue`, `do-item`, `work-batch`, the deferral step and
  `reflect` decide what to file, label or comment; the scripts write it.
  `file-issue` checks labels against the repository's taxonomy
  (`skills/file-issue/scripts/validate-labels.ts`) and asks a person first
  unless the autonomy level says otherwise
  (`skills/file-issue/scripts/confirm-step.ts`).
  Every transport and every `ghCall` reports a failed call as one of the
  closed [failure classes](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`shared/outbound/failure.ts`, the `gh` runs read once in
  `shared/outbound/github.ts`); a tracker read the system did not answer is
  sent once more within its deadline (`shared/outbound/retry.ts`), and in a
  tick a system that did not answer is asked nothing more until the next
  tick's probe (`shared/outbound/hold.ts`).
- **If it fails.** The calling session sees exit 1 or 2, or `tracker.ts`'s
  exit for the failure class (5 to 11), and stops; the tick reports a record
  it could not read with the call's class, and does not fail for a class
  that clears by waiting until the failure ledger's count. A person fixes
  credentials or configuration; a missing adapter is a Jig change.

### Pickup: claim, routing, pull-request plan, intent chain

- **Deterministic.** `skills/do-item/scripts/tracker.ts claim` starts an
  issue for the tracker identity: it refuses an item already in progress or
  assigned to someone else (exit 3) and, after writing, stands down when a
  re-read finds another assignee, no longer finds this identity assigned,
  or finds no issue or a state other than `in_progress` (exit 4). Two
  concurrent claims on this host share a file mutex across worktrees.
  `claim --for <identity>` preserves the served person's sole assignment
  and checks writer provenance, holds, blockers and inherited ancestry live.
  GitHub adds an inherited assignee without replacing another one; Linear
  and Jira, which hold one assignee and offer no conditional write, assign
  and then verify through the issue's history that the assignment replaced
  nobody, putting back anyone it did replace
  (`skills/do-item/scripts/lib/tracker/assign-verified.ts`); either way a
  detected race stands down. The mutex is machine-local, and two hosts
  claiming with the same identity write the same assignee and state, which
  the re-read cannot tell apart. With `do_item.claim_marker`, the claim
  marker is the token between hosts
  (`skills/do-item/scripts/lib/claim-token.ts`): posted before the claim
  writes, read back, and of the live markers on the item the earliest wins;
  the other claim withdraws its marker and refuses with nothing written to
  the item. Two read-backs that each lag past the other's post can still
  both win.
  `work-batch` claims each issue of its
  batch with the same command. `skills/do-item/scripts/determine_route.ts`
  derives the implementer's agent, complexity tier, model and effort from
  the item's type, size and labels and the repository's `routing` rules,
  with the rule behind each
  part. `skills/do-item/scripts/pr-plan.ts` applies the repository's
  pull-request policy: the branch name, the base, the draft or ready state,
  the size budget. `skills/do-item/scripts/intent-chain.ts` writes the item's
  [intent chain](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  under `.context/intent-chain/`, and
  `skills/drive-pr/scripts/capture-intent-chain.ts` pins it to the pull
  request once, when the drive is armed.
- **Reasoned.** The `do-item` session reads the item, decides what to build,
  writes the change through its implementer, and reviews it. It follows the
  route and the plan the scripts print rather than choosing its own.
- **If it fails.** The `do-item` session stops on a refused claim and says
  so. A claimed item with no running session is reported by the tick as a
  stalled pickup and never relaunched; a person settles it. A served
  person's item counts only when a pickup of this host claimed it.

### Conflicts and CI repair

- **Deterministic.** `skills/resolve-conflicts/scripts/check-resolution.ts`
  fails a resolution while a path is unmerged or conflict markers remain;
  `skills/resolve-conflicts/scripts/conflict-map.ts` names each side;
  `skills/resolve-conflicts/scripts/record.ts` records the decisions.
  `skills/fix-ci/scripts/parse-ci-log.ts` fetches a failed run's log, and a
  failing commit status's through the repository's `ci.log_command`, and
  sorts their errors in the order to fix them. `shared/ci-infra.ts` reads the
  same log for a failure of the infrastructure rather than the code (a lost
  runner, a setup step's network failure, no code diagnostic); the drive
  re-runs such checks, or moves the head to run them again, instead of
  spending a repair round on them.
- **Reasoned.** The drive's conflict and CI repair rounds, or a person's
  `/jig:resolve-conflicts` or `/jig:fix-ci` session, decide each resolution
  and each fix.
- **If it fails.** The check before the merge concludes, then CI. The pass
  or session doing the repair fixes it; a conflict the repair budget cannot
  settle stops the drive for a person.

### The changelog and the release

- **Deterministic.** Where a repository turns it on (`changelog.file`), a
  pull request adds a
  [change note](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) and
  never edits the changelog or the version; the check
  (`skills/changelog/scripts/check.ts`) refuses a branch that adds to the
  changelog's open section or moves the version, and reads its settings from
  the base branch, so a branch cannot switch it off. After the merge, the
  release step (`skills/changelog/scripts/release.ts`, run by the skill's
  action in CI) writes the notes in, moves the version and deletes the
  notes; `skills/changelog/scripts/tag.ts` plans the tags, which are created
  once the release commit's checks pass. In Jig, the release workflow's
  `push` job mints the App token and pushes the release commit, and its
  `tag-push` job mints a token to create the tags: `main`'s ruleset lets
  only that App, and the repository's administrators, push past it.
- **Reasoned.** `do-item` writes the note before it opens the pull request;
  drive passes and `resolve-review-comments` keep it true through review;
  `resolve-conflicts` converts a branch's changelog edits into a note.
- **Boundary.** The note's words are a model's; the changelog's release
  sections, the version and the tags are the release step's.
- **If it fails.** The changelog check fails the branch, and the session
  that wrote the note fixes it. A failed release run is seen by the
  follow-up pass (in Jig, its tagging arm reads
  `skills/changelog/scripts/status.ts`), which reports it owed; a person
  reruns or repairs it.

### Hooks

- **Deterministic.** The plugin registers an
  [agent-runtime hook](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`hooks/hooks.json` for Claude Code; for Codex, an entry `jig upgrade`
  writes into the Codex home): the turn-budget guard
  (`hooks/turn-budget-guard.ts`),
  which counts a session's turns before every tool call and, near the
  runtime's cap, hands the agent a wrap-up instruction. It reads local files
  only and lets the call through whenever it cannot count. A repository's
  own git hooks (in Jig, `lefthook.yml` at the repository root) run its
  checks on commit and push.
- **Reasoned.** Every session, which the guard acts on; the session decides
  how to write its handoff.
- **If it fails.** The session sees a hook error and the call goes through.
  A defect is a Jig change.

### The audit: probes and judgement

- **Deterministic.** `skills/audit/scripts/score.ts` tests every criterion
  that has a probe against the tracked files and scores one whose
  precondition is missing `absent`; `skills/audit/scripts/config-fit.ts`
  checks the repository's configuration against the schema and the
  repository; `skills/audit/scripts/record.ts check` refuses a record with a
  criterion unscored or without evidence; `skills/audit/scripts/report.ts`
  renders the audit sheet. In Jig, a gate holds Jig's own record and
  configuration to the audit skill (`scripts/check-audit-fit.ts`).
- **Reasoned.** The audit session scores every criterion no probe decides,
  with file-path evidence, and writes the recommendations. A probe's hint
  informs that judgement; it does not replace it.
- **If it fails.** `record.ts check` names what is missing; the audit
  session fixes the record.

### Decisions, documents and reflection

- **Deterministic.** `skills/decide/scripts/resolve-precedent.ts` searches
  the repository's decision records and settled policy before any ruling;
  `skills/adr/scripts/validate-rules.ts` checks the rules derived from
  decision records; the `docs` skill's gates (`skills/docs/scripts/`) check
  frontmatter, the generated index, dates and review scars;
  `skills/reflect/scripts/reflect.ts` and
  `skills/review-reflections/scripts/review.ts` read and write the
  reflection store.
- **Reasoned.** `/jig:decide` rules or escalates; `/jig:adr` writes the
  record; `/jig:reflect` names each finding's class;
  `/jig:review-reflections` proposes, and a person approves, each change.
- **If it fails.** The session sees the non-zero exit; the docs gates fail
  in the repository's CI. The session fixes it, and a person approves what
  changes the scaffolding.

### In Jig's own repository: the site and the post-merge pass

These parts are Jig's own, not the plugin's; they show the same split on
Jig itself.

- **Deterministic.** The site in `website/` renders the repository's
  documents at build time, and its build checks its own links; the website
  workflow deploys every push to `main`. `scripts/website-sync.ts` lists the
  commits since the site was last checked and writes that record
  (`website/content-sync.yaml`) with `--advance`.
- **Reasoned.** The follow-up session (`/followup`, Jig's
  `dispatch.followup_command`, in `.claude/skills/followup/`) checks the
  deploy and what the merge changed on the site; the site-update session
  edits the hand-written copy the build does not reach.
- **If it fails.** A failed deploy run is owed in the follow-up's website
  arm, and its fix goes in the follow-up pull request.

## The other skills

Each of these is run by its own session, which notices a script's failure
and fixes its call. What the script settles, and what the model decides:

| Skill | Its scripts settle | The model decides |
|-------|--------------------|-------------------|
| [code-stats](skills/code-stats/README.md) | everything: `skills/code-stats/scripts/code-stats.ts` classifies every tracked file and counts its lines | nothing; a session only runs it and reads the result |
| [descar](skills/descar/SKILL.md) | which subtrees to work first (`corpus-order.ts`), which lines read like history (`reading-list.ts`, a reading list, not a verdict), and which documents other open pull requests change (`open-pr-docs.ts`), all in `skills/descar/scripts/` | what to remove or rewrite in each document |
| [explain](skills/explain/SKILL.md) | the sheet's rendering (`skills/explain/scripts/explainer-sheet/`) | what the explanation says and which sources it cites |
| [red-team](skills/red-team/README.md) | the plan of personas, a fresh agent process per persona where the runtime has no subagents, checking what each reported, and the one report (`skills/red-team/scripts/red-team.ts`) | each persona's reading and findings |
| [work-batch](skills/work-batch/README.md) | the proposed batch: solo-only issues and issues another person holds left out, the point budget filled in rank order (`skills/work-batch/scripts/candidates.ts`); each issue's claim (`skills/do-item/scripts/tracker.ts claim`) | whether the issues form one coherent change, and the change itself |
| [design-brief-builder](skills/design-brief-builder/SKILL.md) | the returned bundle's landing and its browser check (`skills/design-brief-builder/scripts/handback.ts`, `browser.ts`) | the brief, and how the returned design is merged against the repository's fixes |
| [operator](skills/operator/SKILL.md) | what each answer reads and each request is checked against and writes: `jig ask` and `jig send` (`ask/cli.ts`, `send/cli.ts`) | which address and verb a person's sentence means, how the answer reads in sentences, and whether the person said to send |
| [github-actions](skills/github-actions/SKILL.md), [programmatic-execution](skills/programmatic-execution/SKILL.md), [promote-memory](skills/promote-memory/SKILL.md) | none: they have no scripts of their own | all of it: the workflow review, the analysis script it writes, the lesson promoted |

## Where the boundary rests on instructions

Several parts of the right-hand column above are kept by the instructions
every skill follows and by the forge's own trust rules, not by a check that
stops a model. A team that runs passes unattended should know which:

- **Applying a chosen option.** A
  [structured answer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) gives the pass the
  chosen option, the framed decision and any note. The pass's instructions
  require it to apply that option, permit a note only to narrow it, and
  park again when the note conflicts or asks for more. No script checks
  that the changes implement the option's prose. A dispatched follow-up or
  pickup started on a person's answer to the decision its earlier pass
  framed is handed the option the same way, under the same instructions.
  An option of a decision the dispatcher framed itself is a step the tick
  carries out, with no pass to interpret it.

- **Comments a script trusts by their author.** A ledger and a takeover
  claim count when the drive's own login or an owner, member or
  collaborator wrote them; a follow-up marker when the dispatcher's own
  login or one of those wrote it; a merge-ready announcement, an answer to a
  thread or a parked question when an owner, member or collaborator wrote
  it, and an answer to a need's decision when one other than the
  dispatcher's own login did
  (`shared/trusted-authors.ts`, `dispatch/lib/station-answers.ts`, `shared/records/forge-claims.ts`,
  `skills/drive-pr/scripts/lib/state/ledger.ts`,
  `skills/drive-pr/scripts/lib/driver/rearm.ts`). A pass signed in as the
  same login as the person can therefore post a comment those scripts would
  trust; only the instructions say it must not.
- **The machine's state folders.** Launch records, walls, receipts, the
  outcome log and the drive's state are files under `~/.local/state/jig/`,
  writable by every session the same user runs. Leases and tokens fence the
  scripts that write them (`jig dispatch result` checks its record's token);
  nothing fences a direct write.
- **Sending a person's command.** `jig send` refuses a person's commands
  in a session the line started (`JIG_LAUNCH`), but in a person's own
  session it cannot tell their yes from the model's: that the operator
  sends only on the person's instruction, after showing the dry run, is a
  rule of its instructions.
- **Resolving a thread.**
  `skills/resolve-review-comments/scripts/resolve-thread.ts` refuses resolution
  without a reply from the resolving login after the last substantive reviewer
  comment. The drive's canonical transparent bot follow-up after that reply
  requires no further answer; standalone installs without the drive stay strict.
  A pass holding the forge credential can bypass the script with a direct
  mutation; the credential does not enforce this check. The skill's
  instructions still govern that boundary and whether the fix was pushed.
- **The push and the merge.** A pass pushes through
  `skills/drive-pr/scripts/guarded-push.ts` and
  never merges because its instructions say so: the plugin's only hook is
  the turn-budget guard, which blocks nothing, and the mailbox's
  `hold-push` recheck is armed only for a push that script makes.
  Under `bypassPermissions` only the runtime's own deny rules and hooks
  still stop a command
  ([permission mode](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)).
  A pass runs in that mode only on the host's say: the configuration reader
  refuses the setting in a repository's file
  (`shared/config-layers.ts`), and the dispatcher admits a Codex account only
  on a host that opted in to its bypass (`dispatch/lib/accounts.ts`). A
  checkout's own `.claude/settings.json` is outside that check, and a pull
  request can edit it
  ([a host's opt-in](CONFIGURATION.md#a-hosts-opt-in-to-bypass)).
  In Jig, `main`'s ruleset requires the gates and resolved threads but no
  approving review.
- **A loosened ratchet.** The ratchet accepts a `Ratchet-Loosen` trailer in
  any commit of the range; that only a person may ask for one is a rule of
  the repository's instructions
  (`modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet.ts`).
- **The installed copy.** The scheduled jobs run whichever plugin copy the
  agent tool reports installed, with no check that it matches a released
  version (`runtime/launcher.ts`).
- **The site's sync record.** In Jig, `website/content-sync.yaml` is written
  by `scripts/website-sync.ts --advance` by instruction; no check stops a
  hand edit.
