# Where the model is in the loop: Jig's deterministic and reasoned parts

Some of Jig's parts are programs that run the same way every time. Others
are an AI model reading instructions and deciding. A team that adopts Jig
needs to know which is which. That tells it what it can trust without
reading it, what a model may change, and who notices when something breaks.
Without one page that says so, the line between the two is spread across
every skill's documentation and the code behind it. A reader then has to
trace the scripts to learn that the dispatcher runs with no model in it, or
that the drive ledger is written only by the driver.

This page maps Jig **by mechanism**. For each part it names the
[deterministic part](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
that owns it (the script, where its state lives, what it refuses), the
[reasoned parts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
that use it and what they are trusted to decide there, and who notices a
failure and who is asked to fix it. It is the third view of the same
system: the
[lifecycle map](https://github.com/jig-harness/jig/blob/main/docs/LIFECYCLE.md)
walks it by stage, with the skill that owns each, and
[FACTORY.md](https://github.com/jig-harness/jig/blob/main/FACTORY.md) walks it
by station. Paths are relative to the plugin directory unless they start
with a repository folder.

Contents: [the two kinds of part](#the-two-kinds-of-part) ·
[when a model reads or writes Jig's code](#when-a-model-reads-or-writes-jigs-own-code) ·
[the map at a glance](#the-map-at-a-glance) ·
[each part](#each-part) ·
[where the boundary rests on instructions](#where-the-boundary-rests-on-instructions)

## The two kinds of part

A **deterministic part** is a script with no model in it. Given the same
records it does the same thing, and when a record is missing or unreadable
it refuses or reports instead of guessing. Its state is a file on the
machine or a record on the forge (the code host, GitHub today) that another
script reads back. Examples: the gates, `jig dispatch` and `jig gc`,
`drive.ts`, the tracker scripts, the release step.

A **reasoned part** is a model session working from a skill's instructions.
These are the reasoned parts Jig has:

- **A skill's session**: a person or the dispatcher starts `/jig:do-item`,
  `/jig:audit`, a follow-up command and the like, and the model follows its
  `SKILL.md`.
- **A drive pass**: one headless agent process that `drive.ts` starts for
  each review round
  ([drive-pr](skills/drive-pr/README.md)), for example
  `claude -p "/jig:drive-pr --bots-only <PR>"`. It triages, fixes,
  validates and commits, then ends.
- **An implementer**: the agent `do-item` hands the change to, chosen by its
  [route](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), with read-only
  [scouts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) sent ahead
  of it.
- **The review arbiter**: the
  [`review-arbiter`](agents/review-arbiter.md) agent, which rules on
  contested review findings. It is given only the `Read`, `Grep` and `Glob`
  tools, so it reads and never edits.
- **The review's semantic tier and its lenses**: the reviewers `/jig:review`
  runs over a diff.
- **The audit's judgement**: the scores the audit session gives every
  criterion no [probe](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  settles.

The two kinds meet in one pattern everywhere: **a model decides, and a
script writes the record.** A pass chooses a thread's outcome; the script
`reply-to-thread.ts` posts it, and refuses a reply that does not open with
one of the outcome words. `do-item` decides to take an item; `tracker.ts
claim` writes the claim, and refuses an item that someone else holds. So a
model's decision reaches a shared record only through a script that checks
it.

What a model may change, and what only a script changes:

| A model may change | Only a script changes |
|--------------------|-----------------------|
| the repository's code, tests and documents, on a branch | the drive's state, locks, leases and its ledger comment (`drive.ts`, `drive-state.ts`) |
| a review reply's outcome and its reason (written by a script that checks it) | a thread's resolution and the push (`resolve-thread.ts`, `finish-round.ts`, `guarded-push.ts`) |
| a change note, a decision record, an issue body | the dispatcher's launch records, walls, receipts and outcome log |
| an audit score where no probe decides | the follow-up marker, once claimed (`jig dispatch marker`) |
| an answer to a parked question, when the model is the person's own session | the changelog's release sections, the plugin version and the tags (the release step) |

The right-hand column is protected by different things: some of it by the
forge, some by checks, and some only by the instructions every skill
follows.
[Where the boundary rests on instructions](#where-the-boundary-rests-on-instructions)
lists the parts that only the instructions protect.

## When a model reads or writes Jig's own code

**At run time, never by design.** In a repository that uses Jig, the
programs that run with nobody at the keyboard are deterministic: the
dispatcher's tick (`dispatch/tick.ts`) and the wrapper it starts sessions in
(`dispatch/run.ts`), resource collection (`jig gc`) and the launcher its
scheduled job runs (`gc/launcher.ts`), the timers both install, and the
drive's loop control (`drive.ts`). They start sessions and read how they
ended. The only reasoning is inside the sessions they start: a drive pass,
a pickup's `do-item` session, a follow-up session. Those sessions read
Jig's `SKILL.md` files and run Jig's scripts, but what they write is the
repository's own code, replies and records. The plugin they run is an
installed copy, and a change to it reaches a machine only as a released
version ([releases](README.md#releases)).

**While Jig is being developed, all the time.** Jig is built with its own
tools, so models write Jig's code in exactly the places they write any
repository's code:

- an implementer building a step of a plan, picked up by `do-item`;
- a drive pass fixing what a reviewer flagged, in whatever file the reviewer
  flagged, the dispatcher's own code included;
- a follow-up or site-update session (Jig's own maintenance skills) editing
  status pages and the site's copy.

Which of these a part falls under decides what it is held to:

| Kind of code | Written by | Read or run at run time by | Held to |
|--------------|------------|----------------------------|---------|
| Loop control and machine tools: `dispatch/`, `gc/`, `drive.ts` and its libraries, the gates | models, during development | scripts only | tests that fail first, a deadline on every outbound call, refusing on an unreadable record (the rules in [the plugin's instructions](https://github.com/jig-harness/jig/blob/main/plugin/AGENTS.md)) |
| Skill instructions: `SKILL.md`, references, lens files, the arbiter's definition | models and people, during development | models, every session | the context budget, the skill-authoring counts the ratchet keeps from growing, and checks that a script's exit codes and the prose agree (`skills/drive-pr/__tests__/terminal-states*.test.ts`) |
| The repository's own code and records | models, at run time | the repository's own gates and reviewers | the repository's gates, review rounds, and a person's merge |

## The map at a glance

One row per part. "Noticed by" is the first thing that sees a failure;
"asked to fix" is who gets the work. A defect in a script itself is always a
change to Jig, made by an implementer or a drive pass during Jig's
development and shipped as a version.

| Part | Deterministic owner | Reasoned users, and when | Failure noticed by | Asked to fix |
|------|---------------------|--------------------------|--------------------|--------------|
| [Gates](#gates-and-the-validation-plan) | `gates.command`; CI | implementer before the push; drive pass every round | the session that ran them; CI's required check | the session whose change failed them |
| [Change areas](#gates-and-the-validation-plan) | `skills/change-areas/scripts/` | review, drive pass, fix-ci, through the plan | the session that read the plan (exit 2) | whoever maintains the catalog |
| [`jig` command and timers](#the-jig-command-and-its-timers) | `jig.ts`, `gc/install.ts`, `dispatch/install.ts`, `gc/launcher.ts` | none | the timer's own log; a person | a Jig change |
| [Resource collection](#resource-collection-jig-gc) | `gc/` | none | its receipts (`jig gc receipts`) | a person; a Jig change |
| [Dispatcher's tick](#the-dispatchers-tick) | `dispatch/tick.ts`, `dispatch/run.ts` | the sessions it starts | its receipt; the morning report | a person; a Jig change |
| [Dispatcher's records](#the-dispatchers-records-receipts-outcome-log-dashboard-notifications) | `dispatch/receipts.ts`, `lib/log.ts`, `dashboard.ts`, `lib/notices.ts` | a dispatched session records its result | the dashboard; the morning report | a person, through `/jig:reflect` |
| [Follow-up marker](#the-follow-up-marker) | `dispatch/marker.ts`, `lib/followup-marker.ts` | the follow-up session | the follow-up session (exit 1, 2 or 3) | a person deletes or marks the marker |
| [The drive](#the-drive-driver-locks-leases-ledger) | `skills/drive-pr/scripts/drive.ts` and its libraries | drive passes; the session that arms it | its exit state; the dispatcher; the morning report | the dispatcher re-arms mechanical stops; a person the rest |
| [Review threads](#review-threads-and-the-arbiter) | `skills/resolve-review-comments/scripts/`, `triage-ladder.ts` | drive pass; the arbiter | the pass (non-zero exit), then `drive.ts` | the next pass, or a person on a park |
| [Review and lenses](#review-and-lenses) | `skills/review/scripts/` | review's semantic tier and lens reviewers | the reviewing session (exit 2) | the session, or the repository's lens owner |
| [Tracker and forge](#the-tracker-and-the-forge) | `skills/do-item/scripts/tracker.ts` and its adapters; `gh` under deadlines | every skill that files, reads or claims | the calling session (exit 1 or 2); the tick's report | a person (credentials); a Jig change (an adapter) |
| [Pickup](#pickup-claim-routing-pull-request-plan-intent-chain) | `do-item`'s claim, routing, `pr-plan.ts`, `intent-chain.ts` | the `do-item` session; its implementer | the `do-item` session | the session stops and says why; a person |
| [Conflicts and CI repair](#conflicts-and-ci-repair) | `skills/resolve-conflicts/scripts/`, `skills/fix-ci/scripts/` | the drive's repair rounds; a person's session | the check before the merge concludes; CI | the pass or session repairing |
| [Changelog and release](#the-changelog-and-the-release) | `skills/changelog/scripts/`, the release workflow | implementer writes the note; the pass keeps it true | the changelog check; the release run; the follow-up | the session that wrote the note; a person for the release |
| [Hooks](#hooks) | `hooks/turn-budget-guard.ts` | every session (it acts on them) | the session (a hook error) | a Jig change |
| [The audit](#the-audit-probes-and-judgement) | `skills/audit/scripts/` | the audit session's judgement | `record.ts check`; Jig's audit-fit gate | the audit session |
| [Decisions, documents, reflection](#decisions-documents-and-reflection) | `decide`, `adr`, `docs`, `reflect` scripts | the skills' sessions | the session (non-zero exit); the docs gates | the session; a person approves |
| [Jig's own site and post-merge pass](#in-jigs-own-repository-the-site-and-the-post-merge-pass) | the site build and deploy workflow, `scripts/website-sync.ts` | follow-up and site-update sessions | the deploy run; the follow-up's website arm | the follow-up session, in a follow-up pull request |

## Each part

### Gates and the validation plan

- **Deterministic.** The repository's gate command (`gates.command` in its
  configuration, [CONFIGURATION.md § gates](CONFIGURATION.md#gates)) and CI,
  which is the authority. A drive validates each round by the
  [validation plan](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
  `drive.validation_plan_command` reads the changed files and prints the
  checks they owe, and without one the plan is the gate command alone. The
  change-area resolver (`skills/change-areas/scripts/resolve.ts`) prints such a
  plan from the repository's change-area catalog, and `check.ts` checks the
  catalog itself. No state of its own beyond the catalog file. Refuses: a
  failing check fails the run; the catalog check exits 2 on a schema error.
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
  components (`gc/cli.ts`, `dispatch/cli.ts`); it refuses a malformed
  command line with exit 2. `jig gc install` and `jig dispatch install`
  print the scheduled job first and write it only with `--yes`: a systemd
  user timer, a launchd job or a crontab line (`gc/scheduler.ts`). The job
  runs a launcher copied under `~/.local/state/jig/gc/launcher/`, which asks
  the agent tool (`claude plugin list --json` or `codex plugin list --json`)
  for the installed plugin copy at each run, so an update reaches the job
  without a new install (`gc/launcher.ts`). It refuses to schedule a script
  that lives inside a git checkout, which a worktree cleanup could remove.
  The plugin itself is updated by the agent tool
  ([automatic updates](README.md#automatic-updates)), not by Jig.
- **Reasoned.** None. A person installs the timers; no session is involved.
- **If it fails.** A job that cannot find the installed copy stops with a
  message naming what to run; the scheduler's own log holds it. A person
  reads it. A defect is a Jig change.

### Resource collection (`jig gc`)

- **Deterministic.** `gc/` inventories the leftovers a repository declares
  (scratch folders, tool state, worktrees) and collects only those whose
  owners are proven finished ([resource collection](gc/README.md)). State:
  one receipt per run under `~/.local/state/jig/gc/<date>/`. Refuses: an
  unreadable process identity or forge answer keeps the resource, and an
  abandoned admission token blocks collection rather than being taken over.
- **Reasoned.** None. Sessions only take part as owners: a scratch creator
  holds shared admission while it creates its folder (`shared/gc-lock.ts`).
- **If it fails.** Exit 1 and a receipt that records the failure.
  Nothing notifies anyone: a person reads `jig gc receipts`. A defect is a
  Jig change.

### The dispatcher's tick

- **Deterministic.** `dispatch/tick.ts`, run every interval by the timer
  `jig dispatch install` writes. Under a lock it reads, for each
  repository, the `dispatch` section from the default branch, the tracker,
  the open pull requests and their drive ledgers, and the session runtime's
  sessions; it plans what is wanted and not running, and with `--apply`
  starts what the machine file enables ([the dispatcher](README.md#the-dispatcher)).
  State, under `~/.local/state/jig/dispatch/`: a launch record per session
  (`lib/launches.ts`, written before the launch, so a lost launch still
  holds its slot), each account's usage-limit walls (`lib/walls.ts`), and
  follow-up outcomes (`lib/followup-outcomes.ts`). `dispatch/run.ts` is the
  wrapper a dispatched drive runs in: it claims its record once, starts
  `drive.ts` billed to the admitted account, and writes the exit. Refuses: a
  record it cannot read or a target it cannot place is reported and never
  planned; an account whose configuration directory does not resolve to the
  identity the machine file names starts nothing (`lib/accounts.ts`); a
  launch record already claimed is not started twice. The tick writes
  nothing to the tracker: the session's own claim does
  (`lib/actions/pickup.ts`).
- **Reasoned.** None inside the tick. It starts reasoned parts: a drive's
  passes (through `drive.ts`), a pickup's `/jig:do-item` session, and the
  repository's `dispatch.followup_command`. Its one keystroke into a
  session is the closed nudge after a usage limit resets; every other stuck
  state becomes a notification.
- **Boundary.** Because it reads the `dispatch` section from the default
  branch, a change a model makes on a branch reaches the dispatcher only
  once a person has merged it.
- **If it fails.** The receipt records what it could not read, and the
  morning report (`drives.ts --report`) lists launches it refused or lost.
  No agent watches the tick: a person reads these. A defect is a Jig change.

### The dispatcher's records: receipts, outcome log, dashboard, notifications

- **Deterministic.** A receipt per tick under `receipts/` with what it read
  and planned, kept 30 days unless the machine file says otherwise
  (`dispatch/receipts.ts`). The
  [outcome log](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), one
  row per ended launch and one event row per observed cause, in
  `log-<year>-<month>.jsonl`, which nothing removes (`lib/log.ts`); a stop no
  class fits is logged as `unknown`, never dropped. The dashboard
  (`dispatch/dashboard.ts`) reads the log and writes nothing; it listens only
  on a private or loopback address and refuses a request without its
  token. A notification counts as sent only when the workspace comment,
  read back, carries its key line, and is not sent again while its cause
  stands (`lib/notices.ts`).
- **Reasoned.** A dispatched interactive session records how it ended with
  `jig dispatch result <record> <token> done|failed` (`dispatch/result.ts`).
  That answer is the session's own judgement; the script refuses another
  record's token, a headless pass's record and a second answer. Nothing
  else reasoned writes these records.
- **Boundary.** The tick tunes none of its own settings. A class that keeps
  recurring is a finding a person records with
  [`/jig:reflect`](skills/reflect/README.md) and approves through
  [`/jig:review-reflections`](skills/review-reflections/README.md).
- **If it fails.** A person, from the dashboard or the morning report. Asked
  to fix: a person decides the change; a defect is a Jig change.

### The follow-up marker

- **Deterministic.** A hidden-marker comment on a merged pull request claims
  its follow-up (`lib/followup-marker.ts`). The tick posts one naming its
  launch record before it starts the session. A run by hand uses
  `jig dispatch marker claim`, `check` before each act outside the pull
  request, and `done` at the end (`dispatch/marker.ts`). Of two trusted
  markers the earlier comment wins; only the dispatcher's own login or an
  owner, member or collaborator counts. Refuses: exit 3 when an earlier
  marker holds the follow-up, exit 2 for a comment that is not a trusted
  marker.
- **Reasoned.** The follow-up session decides what the merge still owes and
  does it; it calls the marker commands at the points its instructions name.
- **If it fails.** The follow-up session stops on any non-zero exit. A
  failed follow-up is notified once and never started again; a person
  deletes its marker to have it run again.

### The drive: driver, locks, leases, ledger

- **Deterministic.** `skills/drive-pr/scripts/drive.ts` is the loop
  control: it starts one pass per round, reads the result, and stops in
  exactly one [terminal state](skills/drive-pr/README.md#the-exit-states--what-you-do-now)
  with its exit code. Its state lives in a per-clone folder,
  `~/.local/state/jig/drive-pr/<clone>/` (`scripts/lib/state/store.ts`):
  rounds, the verified head, parked and held items, locks and
  [leases](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). The
  [drive ledger](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  mirrors its resumable part as one comment on the pull request, written by
  the driver at each round boundary, park, takeover and stop
  (`scripts/lib/state/ledger.ts`, `ledger-forge.ts`). A round's finish is
  one script, `finish-round.ts`, which sequences the CI hold, the push
  (`guarded-push.ts`, which re-checks the pull request is still open at the
  moment it pushes), the head-sync wait, and resolving each held thread.
  Refuses: a second drive of the same pull request from this clone (exit
  11) or while the ledger names a running driver elsewhere (exit 13); a push
  while a thread on a touched file is not fully triaged (`finish-round.ts`
  exit 7); a post from a pass whose lease was revoked
  (`assert-post-allowed.ts`); a ledger version it cannot read (exit 1).
- **Reasoned.** Each pass decides, for every finding, its outcome and its
  fix, at the repository's autonomy level
  ([drive-pr § Autonomy](skills/drive-pr/SKILL.md#autonomy-what-the-pass-decides-without-a-person)).
  It parks what only a person decides, and parks only under the registry's
  classes. It mutates drive state only through `drive-state.ts`, behind its
  lease. The session that arms a drive (`arm-drive.ts`, from `do-item` or a
  person) decides when to start it.
- **Boundary.** The drive never merges, approves or requests changes, and
  never resolves an accepted thread before its fix is verified on the
  remote head ([drive-pr § What it will never do](skills/drive-pr/README.md#what-it-will-never-do)).
- **If it fails.** The exit state says what happened. `INDETERMINATE`
  (exit 1) asks the caller to run it again. The dispatcher re-arms a drive
  stopped on a usage limit or an answered park, and notifies a person about
  every stop only a person settles. The morning report lists each drive. A
  defect in the driver is a Jig change.

### Review threads and the arbiter

- **Deterministic.** The thread scripts in
  `skills/resolve-review-comments/scripts/`: `list-unresolved-threads.ts`
  reads them; `reply-to-thread.ts` posts a reply in the thread and refuses
  one that does not open with an outcome word; `resolve-thread.ts` resolves
  only after a fix or reply; `triage-ladder.ts` gives the mechanical verdict
  on a finding against the decline ladder; `file-deferred.ts` files the
  findings a pull request deferred through the tracker adapter, reusing an
  issue already filed for the same entry. `converge.ts` repeats passes when
  no drive runs.
- **Reasoned.** The pass (or a person's session) reads each finding and
  chooses its outcome. Findings the rubric and the ladder do not settle go
  to the [review arbiter](agents/review-arbiter.md), which rules
  (fix now, rejected, won't fix, defer, escalate) and edits nothing.
- **Boundary.** A comment counts as a person's answer only when GitHub
  reports its author as an owner, member or collaborator
  (`shared/trusted-authors.ts`), whatever the comment says.
- **If it fails.** The pass sees the script's non-zero exit and stops or
  parks; `drive.ts` reads the round's outcome. The next pass, or a person on
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

- **Deterministic.** Every skill reaches the issue tracker through
  `skills/do-item/scripts/tracker.ts` and the
  [tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  behind it (`scripts/lib/tracker/`, with adapters for GitHub Issues,
  Linear and Jira); `get_issue.ts` and `list_comments.ts` read through the
  same interface. The forge is GitHub, reached through the signed-in `gh`
  client: each drive and dispatcher call goes through `ghCall` with a
  deadline (`skills/drive-pr/scripts/lib/proc.ts`), and the dispatcher's
  reads either answer in full or throw, so a population read in part is
  never planned from (`dispatch/lib/forge.ts`). Refuses: `get_issue.ts`
  exits 2 when the tracker cannot be reached; `list_comments.ts` never
  prints a partial list.
- **Reasoned.** `file-issue`, `do-item`, `work-batch`, the deferral step and
  `reflect` decide what to file, label or comment; the scripts write it.
  `file-issue` checks labels against the repository's taxonomy
  (`skills/file-issue/scripts/validate-labels.ts`) and asks a person first
  unless the autonomy level says otherwise (`confirm-step.ts`).
- **If it fails.** The calling session sees exit 1 or 2 and stops; the tick
  reports a record it could not read. A person fixes credentials or
  configuration; a missing adapter is a Jig change.

### Pickup: claim, routing, pull-request plan, intent chain

- **Deterministic.** `tracker.ts claim` starts an issue for the tracker
  identity: it refuses an item already in progress or assigned to someone
  else (exit 3) and stands down when a re-read shows another claim landed
  first (exit 4). `determine_route.ts` derives the implementer's agent,
  model tier and effort from the item's labels and the repository's
  `routing` rules, with the rule behind each part. `pr-plan.ts` applies the
  repository's pull-request policy: the branch name, the base, the draft or
  ready state, the size budget. `intent-chain.ts` writes the item's
  [intent chain](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  under `.context/intent-chain/`, and `capture-intent-chain.ts` pins it to
  the pull request once, when the drive is armed.
- **Reasoned.** The `do-item` session reads the item, decides what to build,
  writes the change through its implementer, and
  reviews it. It follows the route and the plan the scripts print rather
  than choosing its own.
- **If it fails.** The `do-item` session stops on a refused claim and says
  so. A claimed item with no running session is reported by the tick as a
  stalled pickup and never relaunched; a person settles it.

### Conflicts and CI repair

- **Deterministic.** `skills/resolve-conflicts/scripts/check-resolution.ts`
  fails a resolution while a path is unmerged or conflict markers remain;
  `conflict-map.ts` names each side; `record.ts` records the decisions.
  `skills/fix-ci/scripts/parse-ci-log.ts` fetches a failed run's log and sorts
  its errors in the order to fix them.
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
  the base branch, so a branch cannot switch it off. After the
  merge, the release step (`skills/changelog/scripts/release.ts`, run by the
  skill's action in CI) writes the notes in, moves the version and deletes
  the notes; tags follow once the release commit's checks pass (`tag.ts`).
  In Jig, the release workflow pushes the release commit with a token only
  the release job can mint: `main`'s ruleset lets only that App, and the
  repository's administrators, push past it.
- **Reasoned.** `do-item` writes the note before it opens the pull request;
  drive passes and `resolve-review-comments` keep it true through review;
  `resolve-conflicts` converts a branch's changelog edits into a note.
- **Boundary.** The note's words are a model's; the changelog's release
  sections, the version and the tags are the release step's.
- **If it fails.** The changelog check fails the branch, and the session
  that wrote the note fixes it. A failed release run is seen by the
  follow-up pass (in Jig, its tagging arm reads `status.ts`), which reports
  it owed; a person reruns or repairs it.

### Hooks

- **Deterministic.** The plugin registers one
  [agent-runtime hook](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  (`hooks/hooks.json`): the turn-budget guard (`hooks/turn-budget-guard.ts`),
  which counts a session's turns before every tool call and, near the
  runtime's cap, hands the agent a wrap-up instruction. It reads local files
  only and lets the call through whenever it cannot count. A repository's
  own git hooks (in Jig, `lefthook.yml`) run its checks on commit and push.
- **Reasoned.** Every session, which the guard acts on; the session decides
  how to write its handoff.
- **If it fails.** The session sees a hook error and the call goes through.
  A defect is a Jig change.

### The audit: probes and judgement

- **Deterministic.** `skills/audit/scripts/score.ts` tests every criterion
  that has a probe against the tracked files and scores one whose
  precondition is missing `absent`; `config-fit.ts` checks the
  repository's configuration against the schema and the repository;
  `record.ts check` refuses a record with a criterion unscored or without
  evidence; `report.ts` renders the audit sheet. In Jig, a gate holds Jig's
  own record and configuration to the audit skill (`scripts/check-audit-fit.ts`).
- **Reasoned.** The audit session scores every criterion no probe decides,
  with file-path evidence, and writes the recommendations. A probe's hint
  informs that judgement; it does not replace it.
- **If it fails.** `record.ts check` names what is missing; the audit
  session fixes the record.

### Decisions, documents and reflection

- **Deterministic.** `skills/decide/scripts/resolve-precedent.ts` searches
  the repository's decision records and settled policy before any ruling;
  `skills/adr/scripts/validate-rules.ts` checks the rules derived from decision
  records; the `docs` skill's gates check frontmatter, the generated index,
  dates and review scars; `skills/reflect/scripts/reflect.ts` and
  `skills/review-reflections/scripts/review.ts` read and write the reflection
  store.
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
  `dispatch.followup_command`) checks the deploy and what the merge changed
  on the site; the site-update session edits the hand-written copy the
  build does not reach.
- **If it fails.** A failed deploy run is owed in the follow-up's website
  arm, and its fix goes in the follow-up pull request.

## Where the boundary rests on instructions

Several parts of the right-hand column above are kept by the instructions
every skill follows and by the forge's own trust rules, not by a check that
stops a model. A team that runs passes unattended should know which:

- **Comments a script trusts by their author.** The drive ledger, takeover
  claims, the follow-up marker and a parked question's `answer <key>: …`
  are trusted when their author is the driver's own login or an owner,
  member or collaborator (`shared/trusted-authors.ts`,
  `skills/drive-pr/scripts/lib/state/ledger-forge.ts`,
  `dispatch/lib/followup-marker.ts`, `skills/drive-pr/scripts/lib/driver/rearm.ts`).
  A pass signed in as the same login as the person can therefore post a
  comment those scripts would trust; only the instructions say it must not.
- **The machine's state folders.** Launch records, walls, receipts, the
  outcome log and the drive's state are files under `~/.local/state/jig/`,
  writable by every session the same user runs. Leases and tokens fence the
  scripts that write them (`jig dispatch result` checks its record's token);
  nothing fences a direct write.
- **The push and the merge.** A pass pushes through `guarded-push.ts` and
  never merges because its instructions say so: the plugin's only hook is
  the turn-budget guard, which blocks nothing. Under `bypassPermissions`
  only the runtime's own deny rules and hooks still stop a command
  ([permission mode](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)).
  In Jig, `main`'s ruleset requires the gates and resolved threads but no
  approving review.
- **A loosened ratchet.** The ratchet accepts a `Ratchet-Loosen` trailer in
  any commit of the range; that only a person may ask for one is a rule of
  the repository's instructions
  (`modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet.ts`).
- **The installed copy.** The scheduled jobs run whichever plugin copy the
  agent tool reports installed, with no check that it matches a released
  version (`gc/launcher.ts`).
- **The site's sync record.** In Jig, `website/content-sync.yaml` is written
  by `scripts/website-sync.ts --advance` by instruction; no check stops a
  hand edit.
