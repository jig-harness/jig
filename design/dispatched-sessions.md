# What a dispatched session leaves and where it runs: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) starts every
stage of Jig's line as a [headless pass](../GLOSSARY.md): an agent run with
nobody at its prompt (`claude -p`, `codex exec`), opened in a terminal tab of
the one [session runtime](../GLOSSARY.md) it has, Orca. Several things go wrong.
What a run concluded is lost: the wrapper it runs in passes its output
through and keeps only its last `Question:` line, so why a run died or
stalled is found only in the tab it left or in the agent vendor's
transcript. Runs leave terminals behind: a run that parks or fails keeps
its tab so that a person can read it, and nothing closes that tab once its
pull request merges, so on a host that runs the dispatcher most of the
workspaces it created belong to merged pull requests, many still holding
live terminals. And every run needs one desktop app: without Orca, Jig
cannot dispatch at all.

With this built, every dispatched run ends with a **closing report**, a
short structured record of what it concluded, written by the agent that did
the work, and the dashboard and `jig ask` show it. Since the report keeps
what a person needs, a run's tab closes on every exit. A second session
runtime, the **process runtime**, runs a pass as a plain managed process in
a worktree Jig opens itself, so a host needs no terminal kept open and no
desktop app to dispatch; once it has run on a host that dispatches, it
becomes the default, and Orca stays supported as an option.

This is the design of [plan.md](plan.md) item 51. Step 1 of the
[build order](#build-order) is built: the `closing-report/v1` check,
`jig dispatch report`, the report on the launch record and the outcome
log, and the prompts that ask for it; the rest is not. It
builds on the dispatcher (item 33,
[dark-factory-dispatch.md](dark-factory-dispatch.md)), whose
[session runtime interface](dark-factory-dispatch.md#the-session-runtime-interface)
the process runtime implements, and on the
[steward](../plugin/skills/steward/README.md), which reads a run's
transcript when the run left no report. It amends
[ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md).

These are settled and not reopened here: a run's conclusion is kept in
structured form and its raw output is not; the agent that did the work
writes the report, and no second agent summarises transcripts; the steward
reads a transcript only when a run ended without a report; a run's tab
closes on every exit; the process runtime is chosen in the host's
[machine file](../plugin/CONFIGURATION.md#the-machines-dispatch-file),
never by a repository, and becomes the default once it has run on a host
that dispatches; dispatched sessions send no phone notices, and the
[dispatch dashboard](dispatch-dashboard.md) is the signal; and `jig gc`'s
own fixes (#990, #991) land before any step here that changes how sessions
behave.

## How it works

### The closing report

A closing report is one JSON record, `closing-report/v1`. It holds
conclusions, never output:

| Field | Required | What it holds |
| --- | --- | --- |
| `concluded` | yes | What the run concluded, in the agent's words: at most 600 characters. "Opened #812 for the item; its drive is armed." "Stopped: the item asks for a schema the repository does not have." |
| `question` | when a person must decide | The question for a person, one line ending in `?`, at most 1000 characters. With a framed decision, its `call.question` |
| `decision` | with `question`, where the pass can frame it | A [`parked-decision/v1`](structured-answers.md) record, checked as `jig dispatch result --decision` checks one today |
| `suggested_next` | yes | The next step the agent suggests: `step`, at most 300 characters, and `owner`, one of `line` (a stage of the line takes it: a drive, a follow-up), `person` (with `act` from the steward's closed list: `Merge`, `Decide`, `Authorize`, `Reply`, `Do`, `Investigate`) or `none` |
| `cause` | when the run ended short of its goal | One class from the closed list below |
| `evidence` | no | Up to 10 references, never contents: `pr:#12`, `commit:<sha>`, `item:<key>`, `path:<path in the repository>`, `run:<CI run address>` |

The record names no secret and no person's data. The command that stores it
replaces anything shaped like an email address, an account identifier or a
token with `<redacted>`, as the drive ledger does.

**One list of causes, each with its writers.** A run's `cause` says why it
fell short; the outcome log's existing `class` (`OUTCOME_CLASSES` in
[`plugin/dispatch/lib/log.ts`](../plugin/dispatch/lib/log.ts)) says how it
ended, read from its exit and result, and both are kept: a run that ended
`failed` may have fallen short for any of these reasons.

| Cause | Written by |
| --- | --- |
| `needs-person`, `refused`, `tool-failed`, `environment`, `scope` | the agent, in its report, or the steward |
| `deadline`, `startup`, `usage-limit` | the wrapper or the driver, from what it observed, or the agent where it knows |
| `crashed` | the steward, from a transcript |
| `unknown` | anyone, when nothing else fits |

**Who writes it, and how.** One command, `jig dispatch report <record>
<token> <file>`, takes the report, separate from `jig dispatch result`. A
pass may run it more than once, before or after its result; the last report
that passes the check stands. A report that fails the check is refused with
what is wrong, so the pass can fix it and run the command again, and it
never touches a result already recorded. Each kind of run writes it this
way:

- **A pickup, a follow-up or the steward**: the prompt the tick composes
  names the command with the record's token, beside the `result` command,
  and asks for the report as the pass's last act. `do-item` records its
  result as soon as its pull request's drive is armed and goes on; its
  report comes at the end.
- **A drive** runs many passes under `drive.ts`, and most of its stops are
  decided by `drive.ts` after a pass has ended (converged, stalled, a wall,
  a pass deadline), so no pass knows it is the last. Each pass therefore
  ends its round by writing a round report, the same fields, to the drive's
  state directory, stamped with the launch record and the round, and never
  into the handoff narrative, whose last lines the drive ledger posts on the
  pull request. When `drive.ts` stops, it writes the closing report (`by:
  driver`): `cause` and `suggested_next` from the
  [terminal-state registry](../plugin/skills/drive-pr/references/terminal-states.md)'s
  entry for its exit, and `concluded` from the stop's own text followed by
  the last round report of this launch, the stop's text first and the round
  report's `concluded` cut to the room left in the 600 characters. The stop's
  own text is cut to the limit too when it alone exceeds it, so the composed
  field always passes the check. `question` and `decision` come
  from the drive's own state, never from a round report: at a park the
  driver copies the question and the framed decision of the parked item
  the stop prints (the first, when several are parked, naming how many
  more wait), and a stop that parks nothing writes neither. A round report stamped with
  another launch or an earlier round is never read. The wrapper records
  the report under its token.

**Where it is kept.** The launch record keeps the report whole beside the
result, so the tick and the steward read it while the record lives. The
outcome log's `ended` row for the record carries `concluded`, `question`,
`suggested_next`, `cause` and who wrote the report (`by`: `agent`,
`driver`, `wrapper`, `steward`, `person` or `none`), with `cause` and `by`
as columns the dashboard filters on. When the report has a `question`, the
row also keeps its framed `decision`, so a question parked beyond the launch
record's retention still carries the options a person answers from; the row
gains that field with the others in step 1. The row's existing `next`, the tick's
own reading of who holds the work next, is unchanged. Launch records expire
with the machine file's retention; the log keeps every row, so it holds a
run's conclusion for as long as the factory learns from it. The `Question:`
line the wrapper keeps today stays as the fallback for a run that ends
without a report.

On a host the machine file lists with `owner: false`, the report stays on
that host, in its launch record and its own log. The end the wrapper writes
onto the shared claim, which the owner host reads, gains the report's
`cause` and `by`, never its free text, since the shared claim lives where
others can read it.

**Where it is shown.**

- The dashboard: each piece of work's page lists its runs, newest first,
  each with its `concluded`, `suggested_next` and `cause`. The log view
  shows them on the run's line and filters on `cause` and `by`. *What needs
  you* shows a report's `question` and `decision` where it shows a pass's
  `Question:` today, with `concluded` beside them as context. Where the
  agent's `suggested_next` and the tick's `next` differ, the page shows
  both and decides nothing.
- `jig ask <pull request|item>`: the status card gains a *Last run* line:
  the stage, when it ended, `concluded` and `suggested_next`.
- The run's own output: the wrapper prints the report as its last lines, so
  a person watching the run sees it there too.

### When a run's tab closes

On the Orca runtime, every exit closes the run's tab. The report, or the
cause the wrapper, the driver or the steward recorded, holds what a person
read the tab for, and a drive's output stays in its driver log
(`drive-pr-<PR>.log`), as it does today. The run tab rules stay as they
are ([`plugin/shared/orca-tabs.ts`](../plugin/shared/orca-tabs.ts)): only
the recorded terminal is closed, never a pane a person added, and a
terminal someone typed into stays open.

| Exit | What the report is | The tab |
| --- | --- | --- |
| Converged, or a pass recorded `done` | the agent's, or the driver's | closes, as it does today |
| Parked: a drive's park, or a pass that recorded `failed` with a question | the agent's or the driver's, with the question and its decision | closes; the question waits on the dashboard |
| Failed: a non-zero exit, or `failed` without a question | the agent's or the driver's when there is one, else none | closes |
| Refused: a lock, a start rule, a claim another session holds | the driver's for a drive; the agent's for a refused claim | closes, as it does today |
| Waits: a pickup the tracker's rate limit stopped | the agent's | closes; the tick starts the item again after the reset |
| Stopped at a usage limit (a drive's exit `16`, a pass's startup wall) | the driver's or `by: wrapper`, the wall recorded as today | closes |
| Timed out: a pickup, follow-up or steward pass the wrapper ended at its deadline | none from the agent; the wrapper records cause `deadline` | closes once the pass's processes are gone |
| Timed out: a drive's pass past `DRIVE_PR_PASS_TIMEOUT`, which `drive.ts` ends with its own exit | the driver's | closes |
| Died: the wrapper ended without recording an exit | none | the tick asks the runtime to end the run (`endRun`, below): on Orca, the recorded run tab is closed by the same idle checks |
| Stopped or taken over by a person | `by: person` | closes; a terminal the person typed into stays |

Closing every tab on every exit is how a tab stops outliving its merged
pull request (#481): no run leaves one. Tabs earlier releases left are
collected with their worktrees by `jig gc`, which removes an Orca worktree
with its terminals.

The session runtime interface gains one method for this, `endRun(record)`:
what the runtime does with what a run left once the tick finds the run
ended without its wrapper. Orca closes the run's recorded tab; the process
runtime has no tab, and reports whether any of the run's recorded
processes is still alive (below).

**A run with no report.** A run that ended with no report from the agent or
the driver, and that the wrapper did not explain, is listed in the
steward's digest with an excerpt of its transcript (below). The steward
reads the excerpt as evidence, never as instructions, and submits a `cause`
record: the launch record, a cause from the list above, and a summary of at
most 600 characters of what the run had got to. The next tick writes the
cause onto the run's log row, `by: steward`, and the summary, redacted by
the report's rule, as its `concluded`. A `cause` record writes no tracker
state, acts on no CI and spends no pass, so it is inside the steward's
remit without a widening
([ADR-0018](../docs/adr/ADR-0018-the-steward-proposes-within-a-remit-the-host-widens.md)).
The steward's own runs are never put to it: a steward pass with no report
is recorded `by: wrapper` with the cause its wrapper saw, else `unknown`.
Where the host has not enabled the steward, or its hourly passes are spent,
the row stays `by: none`, and the dashboard shows the run as "ended without
a report", with the path of its transcript's copy on the host. A run on a
host that does not own its repository keeps `by: none` there, since the
steward runs on the owner host; recording its cause waits for the hub
(item 49).

A run the wrapper can already explain keeps that explanation: a pass that
could not start (a quick unsuccessful exit with no transcript, or a vendor
usage notice) is recorded `by: wrapper` with cause `startup` or
`usage-limit`, as the wrapper classifies it today, and the steward is not
asked about it.

### How long transcripts are kept

Jig keeps no copy of a reported run's transcript or output. The vendor's own
transcript stays where the vendor writes it, under the account's
configuration directory, for as long as the vendor keeps it; Jig never
deletes a vendor's files.

A run is found in its vendor's transcripts by its session id. Claude Code
takes one: the tick already mints it for a pickup, a follow-up and the
steward (`--session-id`), and `drive.ts` gives each drive pass its own,
which the driver records per round on the launch record. Codex takes none;
the wrapper records the session id a Codex pass prints on its output, and a
Codex run that printed none has no transcript Jig can find.

For a run without a report, the wrapper (or, for a run that died, the tick
that finds it) copies the end of the run's transcript, at most 2 MiB, with
tokens redacted, into the run's state directory
(`~/.local/state/jig/dispatch/runs/<record>/`, readable only by its owner).
The copy exists because the vendor may prune its transcript before anyone
reads it, and a person may want more than the steward's excerpt. The
steward's digest carries an excerpt of the copy, at most 64 KiB: the run's
last assistant turns and every tool error after its last success. The copy
is removed seven days after the steward's cause is applied, which leaves a
person time to look, and at the latest after the machine file's
`receipts_days` (30 by default), with the launch record. A run's bounded
output, where the wrapper keeps one for the steward, follows the same rule:
it is kept only for a run without a report, and removed with the
transcript's copy.

### The process runtime

A host selects it in its machine file:

```yaml
runtime: process    # orca (the default until the default changes) or process
process:
  path: /home/me/.local/bin:/usr/local/bin:/usr/bin:/bin   # the runs' PATH
  env_keep: []      # further variables a run keeps, by name
```

A repository cannot set either, and an environment variable cannot
override them, as for every field of that file. The tick builds the runtime
the file names and reaches it only through the [session runtime
interface](dark-factory-dispatch.md#the-session-runtime-interface): nothing
in the tick changes but the new `endRun`. The implementation is
`plugin/dispatch/lib/runtime/process.ts`.

| Method | On the process runtime |
| --- | --- |
| `sessions(repo)` | Every worktree of the repository's checkout (`git worktree list --porcelain`), joined to items and pull requests by branch as Orca's are. An agent in state `working` is each launch record that names the worktree and has any recorded process alive under its identity: the wrapper's, or a pass's (below). Any other process with its working directory in a worktree (a person's shell or session, by the idle-holder test the opener uses) counts as one terminal whose state cannot be told, so the tick reads that worktree's target as unknown, never as "no session" |
| `openWorkspace` | A git worktree under the runs root, opened by the workspace rules Orca's open uses today (branch choice, an existing checkout first, an idle holder detached, the repository's create hook run once), moved from `plugin/shared/orca-workspace/` to a shared opener both runtimes call |
| `launch` | The wrapper, `run.ts <record> <token>`, started as a run of its own (below) |
| `notify` | None: refused, saying the dashboard lists the cause. A machine file that enables the `notify` stage on this runtime is refused, naming the field |
| `steer` | None: a headless pass has no input prompt to nudge, and this runtime starts no interactive session (`interactiveBinding` answers no) |
| `retire` | Nothing to retire: there is no notices workspace |
| `endRun` | Reports whether any of the run's recorded processes is alive; never kills one |

**One run, start to end.** Take a pickup of item #123 on a host with
`runtime: process`, and the drive it leads to.

1. **Admission.** The tick admits an account as it does today
   ([Admission by account](dark-factory-dispatch.md#admission-by-account)),
   writes the launch record with its token, and resolves the identity the
   run's environment (below) yields for that account before it launches.
2. **The worktree.** `openWorkspace` finds or makes the worktree for the
   item's branch, at `$JIG_HOME/worktrees/<repository>/<branch>` (`JIG_HOME`
   is `~/.jig` by default; `<repository>` is the checkout's directory name
   with a short digest of its path, so two checkouts never share a
   directory). From the moment it starts until the launch record names the
   worktree, whether it creates the worktree or reuses one, the opener holds
   `jig gc`'s shared admission (`plugin/shared/gc-lock.ts`), and before
   releasing it, it writes the worktree's owner record: the runtime
   (`process`), the repository, the branch and the launch record. That makes
   it the first worktree opener to share session admission, which is what
   the collector waits on before it collects a worktree no workspace runtime
   manages ([`plugin/gc/README.md`](../plugin/gc/README.md)).
3. **The run.** `launch` starts the wrapper as `bun --no-env-file
   --config=<plugin>/dispatch/bunfig.toml <plugin>/dispatch/run.ts <record>
   <token>`, with the installed plugin's absolute paths, as an Orca tab's
   command does, so a configuration file or environment file in the
   worktree, which holds branch-controlled content, is never loaded before
   the wrapper has claimed and checked its record. It runs as a run the
   host's service manager keeps apart from the tick, because the tick
   itself runs as a timer's job, and a job's end takes the processes it
   started with it (a `Type=oneshot` systemd service kills its whole control
   group when it exits):
   - systemd: a transient user unit per run (`systemd-run --user
     --unit=jig-run-<record> --collect`), whose control group holds the
     wrapper and everything it starts;
   - launchd: a job of its own per run, labelled with the record;
   - Windows: a one-time scheduled task per run, outside the tick's job
     object;
   - cron, which ends nothing when its command exits: a new session and
     process group (`setsid`).

   Its working directory is the worktree and its standard input is closed.
   The wrapper reads its pass's output through a pipe it owns, passes it to
   the run's spool, `~/.local/state/jig/dispatch/runs/<record>/output.log`,
   and keeps that file to its last 4 MiB. The wrapper claims its record
   before anything else, as it does in an Orca tab, so a launch called again
   under the same key finds the record claimed and starts nothing. It
   records its own process identity, and each pass's identity and process
   group as it starts it, on the launch record and in the worktree's owner
   record: the pass leads a group of its own, so it can outlive a wrapper
   that was killed, and every reader that asks whether the run is alive
   (`sessions`, `endRun`, `attach`, the collector) reads all of them.
4. **The account and the environment.** The run's environment is built
   from a list, never inherited from the tick: `HOME`, `USER`, `LANG` and
   the `LC_` variables, `TMPDIR`, `JIG_HOME` when the tick has it set, so the
   pass reads the host configuration directory the tick admitted it under,
   `PATH` from the machine file's
   `process.path` (by default the `PATH` that `jig install` recorded for the
   timer's job), the variables `process.env_keep` names, the account's
   configuration directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`), and
   `JIG_LAUNCH`. A credential variable (`CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the other vendor's directory
   variable) is never kept, even when `env_keep` names it, and that is
   refused, naming the field. Git and the forge's command line reach their
   credentials the way they do in any shell: from their own files under
   `HOME`. A forge token variable (`GH_TOKEN`, `GITHUB_TOKEN`) reaches a run
   only when the host lists it in `env_keep`. The identity check in step 1
   reads this same environment, so a pass bills the account it was
   admitted on or starts nothing.
5. **The pickup's drive.** A pickup arms its pull request's drive at the
   end of `do-item`. In a session that `JIG_LAUNCH` marks on the process
   runtime, the arm starts nothing itself (`arm-drive.ts` answers `owed`):
   the pass records `done --pr <number>`, and the tick, finding a pickup's
   pull request with no drive and no ledger, launches its first drive
   through the runtime, as a re-arm is launched, on an admitted account. A
   drive started any other way would run outside the runtime's records, or
   end with the pickup's run.
6. **The exit.** The wrapper records the exit and the closing report,
   writes the launch's end onto the shared claim, and ends; its unit or job
   ends with it. With a report, it removes the spool; without one, it keeps
   the spool and copies the transcript's end as above. There is no tab to
   close. A pass process the tick finds alive after its launch record ended
   is written to the outcome log as an `outlived` event, and reported; it is
   never killed unasked.
7. **Collection.** `jig gc` reads the owner record and marks the worktree
   `runtime: process`. It collects it when every launch record that names
   it has ended, none of their recorded processes is alive, no other process
   holds it, and the collector's existing git and pull-request checks pass.
   It runs the base branch's remove hook as it does for Orca, parks unsent
   reflection findings, and removes the worktree with `git worktree remove`
   under its exclusive admission, reading the launch records and the
   process holders again in its final proof. The runs root is one of the
   collector's declared roots whenever it exists, whatever runtime the host
   uses now, so a host that goes back to Orca still has its old runs
   collected.

**Attaching to a run.** A person may watch a run or take it over:

- `jig dispatch attach <record>` prints the run's worktree, account name,
  stage and how long it has run, then follows its spool until the run ends.
  Interrupting it detaches the person and leaves the run going.
- `jig dispatch attach <record> --take-over` first holds the run's target in
  the person's name, as `jig send hold` does, while the run still holds its
  slot and its in-flight launch, so a tick already planning the target
  finds it held and admits nothing. Only then does it stop the run (its
  unit or job, else its recorded process groups, or the sampled descendants
  on Windows) and record its end `by: person`, which releases the account's
  slot; the tick starts nothing on the target until that person releases the
  hold. A drive taken over is stopped through `drives.ts --stop` too, so its
  ledger reads stopped. If the command dies after the hold and before the
  end, the hold stands and the run may still be live or may already be
  stopped with its end unrecorded, and running the command again reconciles
  either: it stops a live run, records the end and releases the slot. It then prints the command that resumes the vendor's session in
  the worktree, bound to the same account's directory: `claude --resume
  <session-id>` for Claude Code, the last pass's id for a drive; Codex's
  resume for a session whose id the run recorded, and for one without, a
  line saying it cannot be resumed and naming the worktree. The command is
  printed, not run: the person runs it in a shell of their own, and the
  session is theirs, never counted in the account's slots.

Neither form needs Orca or a desktop app. On an Orca host the run's tab
already shows the run, so `attach` is offered on the process runtime only.

### Choosing an account without Orca's roster

ADR-0011 chose Orca partly for its account roster. The dispatcher does not
read that roster: the accounts it bills are listed in the machine file
(`accounts[]`, each with its vendor, configuration directory, identity and
`max_per_account`), and the cap, the turn between accounts and each
account's [wall](../GLOSSARY.md) are the dispatcher's own records
(`plugin/dispatch/lib/accounts.ts`). A drive stopped by one account's usage
limit writes that account's wall, and the next tick admits its re-arm on the
next account in turn with no wall in effect. All of that works the same on
the process runtime.

Only some things came from Orca. The configuration directories are usually
Orca's profile directories; without Orca, a person makes one per account by
signing the vendor's command-line tool into a directory of its own
(`CLAUDE_CONFIG_DIR=<dir> claude`, `CODEX_HOME=<dir> codex login`) and lists
it. And the dispatcher was to read each account's usage from Orca once Orca
offers it (item 34); on the process runtime it relies on walls alone, which
is what it does today.

Binding a process to an account is the step of this design that touches a
credential: a pass that inherits another account's token, or a forge token
the host did not mean to hand it, acts as someone else. The run's
environment is therefore built from a list rather than inherited, and the
identity check before the launch stays. That build step is reviewed as a
security change.

### Notices

Dispatched sessions send no phone notices: no run writes to its workspace
beyond the dispatched mark, marks it unread, or asks its runtime to reach a
person. The dashboard, which a person reaches from a phone
([dispatch-dashboard.md](dispatch-dashboard.md)), is the signal: its *What
needs you* lists every cause the tick finds, whether or not any notice was
sent.

The `notify` stage is a different thing: the tick, not a session, writes a
cause (a park, a stuck record, a failed follow-up) into the repository's
notices workspace on Orca and marks it unread. It stays on Orca, unchanged,
as a stage a host may enable, and the process runtime refuses it. It retires
on Orca too once the outcome log shows it unused: when, over 30 days on a
host that enables it, at least nine in ten of the needs a person answered
were answered before the tick found the notices workspace read. The log
has no such observation today, so the `notify` stage's own tick records one
`notices_read` event per tick with the workspace's read state, and a need
counts as answered first when its answer lands before the first tick that
recorded the workspace read after its notice was written; the one shared
workspace's read state is thus compared with each notice's write time, not
with a per-need mark. That event is added in step 3, with the dashboard.

### Proof before the default changes

The process runtime becomes the default for dispatched sessions once a host
that dispatches has run it, with every stage it enables (pickups, re-arms
and takeovers, follow-ups, the steward), for seven consecutive days and at
least 20 launches, and that week's outcome log shows:

- every run ended with a closing report, or with a cause the driver, the
  wrapper or the steward recorded, and none was still `by: none` after the
  steward's next pass;
- runs went on after the tick that started them ended, and no `outlived`
  event was written;
- every launch billed the account it was admitted on: the identity checks
  either matched or started nothing;
- every pickup's first drive was launched through the runtime;
- every worktree whose pull request merged that week was collected by the
  next collecting `jig gc` run, or was kept with the reason the receipt
  gives;
- a person attached to a running pass once, and took one over once, without
  Orca.

The pull request that changes the default records that week's log export
and adds the dated amendment to ADR-0011 that records the change.

## Build order

One pull request per step, each shippable alone, filed under item 51's
epic after this design merges. None starts before #990 and #991, `jig gc`'s
fixes, have merged.

1. **The closing report, recorded.** The `closing-report/v1` checker and its
   redaction; `jig dispatch report`; the report on the launch record and its
   fields on the outcome log's `ended` row, with the `cause` and `by`
   columns; the prompts the tick composes asking for it.
2. **The closing report from a drive.** `drive-pr`'s round reports; the
   report `drive.ts` writes at its stop; the per-round session ids on the
   launch record; the wrapper recording the report.
3. **The closing report, shown.** The dashboard's run lines, the work's
   page and *What needs you*; `jig ask`'s *Last run* line; the `notices_read`
   event the `notify` stage's retirement measure reads.
4. **The steward's `cause` record.** Runs without a report in the digest,
   with their transcript excerpts; the `cause` record kind; the transcript
   copy and its retention.
5. **Tabs close on every exit.** The wrapper closes its run tab on every
   exit; `endRun` in the interface, and the tick calling it for a record
   that ended without its wrapper. Closes #481.
6. **A worktree opener that shares admission.** The workspace rules moved
   into a shared opener; plain git worktrees under the runs root with owner
   records under `jig gc`'s shared admission; the collector collecting
   `runtime: process` worktrees.
7. **The process runtime.** `runtime` and `process` in the machine file;
   `process.ts` with its methods; a run per service manager, its spool and
   its recorded process identities; the environment built from a list;
   `notify` refused on it; a pickup's first drive launched by the tick. It
   binds a process to an account and decides what reaches the pass's
   environment, so its issue carries the `security` flag.
8. **Attaching to a run.** `jig dispatch attach`, watching and taking over.
9. **The default changes.** After a person's proof week on a host
   ([Proof before the default changes](#proof-before-the-default-changes)):
   `process` becomes the default, the host's machine file can still name
   `orca`, and ADR-0011 gains its amendment.

Steps 1 to 5 change Orca hosts only: the report comes first, and step 5
waits on steps 1, 2 and 4, so that a tab closes only once a report or a
recorded cause holds what it showed. Steps 6 to 8 add the process runtime
without making it the default; step 7 waits on step 6, and step 8 on step
7. Step 9 waits on all of them and on the proof week.

## Left out

- **Building any of it.** This design changes no behaviour; the build order
  is filed after it merges.
- **`jig gc`'s own fixes** (#990, #991), which come first.
- **The closing report as a protocol chapter.** The Jig Protocol (#1016) may
  make the report's shape one of its chapters; this design defines the
  fields only.
- **Causes for runs on a host that does not own the repository**, which
  wait for the hub (item 49) to bring those hosts' records together.
- **A Herdr session runtime**, which ADR-0011 leaves for when Herdr can
  supply what the dispatcher needs; with the dispatcher keeping its own
  account roster, what Herdr would still have to give is a session registry
  and a way to start a run in a workspace.
- **Interactive sessions on the process runtime.** Every dispatched stage
  already runs as a headless pass; a person who wants a conversation takes a
  run over.
- **A summary agent over transcripts**, rejected: it costs more than the
  report and knows less than the agent that did the work.

## Review

Critiqued on 2026-11-13 by a reviewer with fresh context (a subagent that
did not write it), against the draft of this design, its plan item, its
roadmap entry and the ADR-0011 amendment on top of commit `d268b820`.
