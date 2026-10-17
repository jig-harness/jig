# reflect

**What problem this solves.** An agent session often learns something about
the scaffolding it worked in: an instruction that misled it, a skill step that
failed, a gate that let a known problem through, a convention it had to
rediscover. Unless that lesson is written down somewhere durable and someone
later acts on it, the next session learns it again. Without a reflection
system, lessons stay in one session's transcript, or in a chat message nobody
turns into a change. With one, each session records what it learned, the
records from every session and every repository accumulate in one place, and a
periodic review turns them into approved changes to the instructions, skills
and gates.

`/jig:reflect` records; [`/jig:review-reflections`](../review-reflections/README.md)
reviews. Together they are the runnable form of the session-reflection cycle in
[M8](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/README.md). The agent's procedure is in
[SKILL.md](SKILL.md); this page describes how the records work.

Contents: [the loop](#the-loop) · [turning it on](#turning-it-on) ·
[events](#events) · [computed state](#computed-state) ·
[the journal](#the-journal) · [escalation](#escalation) ·
[the store contract](#the-store-contract) ·
[filesystem store](#filesystem-store) · [Notion store](#notion-store) ·
[command store](#command-store) ·
[where reflection is asked for](#where-reflection-is-asked-for) ·
[scripts](#scripts) · [left out](#left-out)

## The loop

1. **Capture.** While a session works, a finding goes into the session's
   [journal](#the-journal), a file in its own worktree. A skill can write one
   itself (the review loop records a review that took many rounds); the agent
   writes one when something goes wrong.
2. **Reflect.** At a natural end (a converged drive, an addressed review, the
   end of a session, before a worktree is removed), `reflect` reads the
   journal, adds what the session itself observed, merges duplicates, names
   each finding's class, and decides what to contribute.
3. **Store.** The contributed findings go to the shared
   [store](#the-store-contract): a folder, or any other store behind the same
   contract. Every repository on the machine (or in the team) contributes to
   the same store.
4. **Review.** Periodically, `review-reflections` reads the store, groups the
   open findings, proposes changes, and asks a person to approve them.
   Approved changes are made through ordinary pull requests.
5. **Close.** Each decision is recorded in the store. A fix counts as
   implemented only once it is merged.

A class of finding that keeps recurring is not filed again: it is
[escalated](#escalation) to one tracker issue that asks for a structural fix.

## Turning it on

Reflection is off until some
[configuration layer](../../CONFIGURATION.md#configuration-layers) has a
`reflection` section. Since the store is shared by every repository, the
section normally goes in the user layer, which turns reflection on in every
repository on that machine:

```yaml
# ~/.jig/jig.yaml
reflection:
  path: ~/.jig/reflections         # the filesystem store's folder (the default)
```

A repository turns it on for everyone who works in it by adding the section to
its own `.config/jig.yaml`, and the section there can override the user's
store; `enabled: false` there turns it off for that repository, and
`JIG__REFLECTION__ENABLED=false` for one run. Every field is in the
[configuration reference](../../CONFIGURATION.md#reflection).

When reflection is off, nothing here happens: the journal takes no notes, the
drive and the review loop ask for no reflection, and the scripts (not the
instructions) decide that.

## Events

The store holds an append-only log of events. Nothing is edited after it is
written; everything that looks like state (a finding's status, the highest
severity of a change) is [computed](#computed-state) from the events when the
log is read. That is what lets a store be a plain folder, and what keeps a
half-finished write from leaving the record inconsistent.

The rule every part keeps: **computed state depends only on the set of
distinct events.** It does not depend on which store holds them, the order a
store returns them in, how many copies of one event a store holds, or which of
two concurrent writers finished first. And a finding leaves the journal only
once the store has it.

There are two kinds of event, each one JSON object, written one per line in
the [JSONL](https://github.com/docomply/jig/blob/main/GLOSSARY.md) format:

```json
{"v":1,"type":"finding","id":"20261012T150405Z-8f3a1c2e9b7d4a60","at":"2026-10-12T15:04:05Z",
 "session":{…},
 "change":{"repository":"github.com/example/web","branch":"eng-12-retry","pull_request":482,"issue":"ENG-12"},
 "kind":"error","severity":"high","class":"narrow-fix-per-round",
 "target":{"scope":"tool","tool":"jig","name":"drive-pr"},
 "title":"Each round fixed one instance of the same missing timeout",
 "description":"…","suggested_fix":"…","time_cost_minutes":40}
```

```json
{"v":1,"type":"decision","id":"20261019T091200Z-1c0e5a7f2d9b3e84","at":"2026-10-19T09:12:00Z",
 "session":{…},
 "finding":"20261012T150405Z-8f3a1c2e9b7d4a60","decision":"approved",
 "reason":"…","commit":"a1b2c3d","pull_request":491}
```

### The finding

| Field | Holds |
|-------|-------|
| `change` | Where the finding came from: the repository (its `origin` remote without protocol or `.git`, or, without one, `local/<folder>-<hash>`, the hash taken from the folder's path), the branch, and the pull request and issue when known. The issue is read from the branch name with the repository's `issue_tracker.team` |
| `kind` | `error` (something went wrong or cost time) or `opportunity` (something could work better) |
| `severity` | `high`, `medium` or `low`; for an opportunity, its priority on the same scale |
| `class` | A short kebab-case name for the failure shape, not the incident: `narrow-fix-per-round`, `instruction-missing-precondition`. Findings of one class are counted together, so a class already in the store is reused when it fits |
| `target` | What the finding is about: `{"scope":"repository","name":"AGENTS.md"}` for the repository's own scaffolding, `{"scope":"tool","tool":"jig","name":"drive-pr"}` for a shared tool |
| `title`, `description`, `suggested_fix` | What happened and the concrete change that would have prevented it |
| `time_cost_minutes` | Optional: the time the problem cost |

### The decision

`decision` is one of `approved` (a change is agreed and on its way),
`implemented` (the change is merged), `deferred` (valid, not now), `dismissed`
(not actionable, already fixed, or the current behaviour is intended; the
reason says which) and `escalated` (the class is handled by a tracker issue;
`issue` names it). `reason` is required. `commit` and `pull_request` record
where an approved change is.

### The session block

Every event, finding and decision alike, carries the session that wrote it:

```json
"session":{
  "jig_version":"0.28.0",
  "skills":["drive-pr","resolve-review-comments"],
  "harness":{"name":"claude-code","version":null,"entrypoint":"cli","wrapper":"herdr"},
  "model":"<model id>",
  "mode":"quick",
  "stated":["model","skills"]
}
```

- **`jig_version`** is read from the plugin's own manifest.
- **`harness`** is read from the environment the harness sets: Claude Code
  sets `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`, Codex sets variables named
  `CODEX_…`. A wrapper that runs the harness adds its own variables; the two
  recognised so far are Herdr (`HERDR_ENV=1`) and Conductor (`CONDUCTOR_…`),
  and under any other `wrapper` is `null`. A harness that sets none is
  stated by the agent.
- **`model`** is stated by the agent: no harness exposes it to a script.
- **`skills`** are the skills the session used, as the agent knows them; a
  skill that writes to the journal itself adds its own name.
- **`stated`** lists the fields the agent supplied rather than the script
  reading them, so a reader knows which values are reported and which are
  measured. A value nobody knows is `null`, never a guess.
- The event's `at` is the time it was written, in Coordinated Universal Time.

With these, the store answers questions such as "which classes rose after
plugin 0.28.0" or "does this class occur under one harness only", so a
regression after a release or a model change shows up as a change in a class's
rate.

### Ids

The writer creates each event's id before the first attempt to store it: the
time and 16 random hexadecimal digits, so ids sort by time and two writers
never pick the same one. A retry after a timeout, or two concurrent writes,
can store one event twice; `list` returns each id once, so a finding is never
counted twice. A finding a script writes for a fact that can recur (the review
loop's round count for one pull request) takes an id derived from that fact
instead (`drv-` and a hash of the repository and the fact), so re-running the
script cannot record it twice.

Two different events under one id mean a writer is wrong, and no store check
can rule that out: two concurrent writers can each find the id absent. So a
store does not try to refuse one at write time. `list` settles it the same way
every time, returning the copy whose stored text sorts first, and `diagnose`
reports the conflict with every copy. The store stays readable, and a person
sees the conflict.

## Computed state

| Question | Answer, from the events |
|----------|-------------------------|
| A finding's status | Its latest decision; `open` when it has none. Decisions are ordered by `at`, then by `id`. A decision written in the same second as a finding's latest takes that second and an id after the latest's, so the decision written last is the latest, whatever order a store returns them in |
| Open findings | Status `open`, or `approved` until it is `implemented` |
| A change's severity | The highest severity among its findings |
| A class's recurrence count | Per owner (below): the owner's findings of that class that are `open` or `deferred`. Each occurrence is its own finding, so a recurring problem raises the count; a deferred finding is still evidence the problem recurs |

A finding's **owner** is where a fix for it would be made: for
`scope: repository`, the repository (`change.repository`); for `scope: tool`,
the tool (`target.tool`). Two repositories' `AGENTS.md` findings have
different owners; findings about one Jig skill from any repository share one.
Recurrence counts, grouping and escalation are all per owner.

## The journal

Each worktree has a journal: a JSONL file git never tracks, by default
`<git-dir>/jig/reflection-journal.jsonl`. In a linked worktree the git
directory is the worktree's own, so each worktree has a separate journal and
removing the worktree removes it. `reflection.journal` moves it, for example to
a scratch folder the repository ignores; the scripts refuse a path git would
track.

The journal holds finding events not yet in the store, and lines about them:
`contributed` (the id, and the reference the store returned), `dropped` (the
id, why it was kept out of the store, and the id it merged into when it was a
duplicate), `parked` (moved to the pending folder, below), `adopted` (a
pending file's lines, taken in at once) and `sending` (written just before a
send). A finding whose send was cut off may already be
in the store, so it cannot be revised or dropped; the next `contribute` asks
the store and marks it contributed if the store has it. A line left
incomplete by a cut-off write is skipped: either the journal still ends with
it, or the next write added a `torn` line after it to say so. Any other line
that is not JSON stops every journal operation, so a damaged journal is never
parked or removed as if it were whole. Lines are only
appended; a finding noted again under its id is a revision, and the last one
counts. Writing to the journal needs no network, no lock and no configuration
beyond the switch, so capturing a finding never fails because the store is
unreachable. When the store is unreachable at `reflect` time, the findings
stay in the journal until the next `reflect` sends them.

**A worktree about to be removed** parks its unsent findings:
`journal.ts park` moves them to `~/.jig/pending/<repository>-<hash>/` (under
`JIG_HOME`; the hash is of the full repository name), and the next `reflect`
in any worktree of the same repository adopts them, with their send marks. A
pending file holding another repository's finding is left where it is. Each
file is adopted as one `adopted` journal line holding its lines, so a cut-off
write adopts all of the file or none of it, and a finding is never in two
journals. A `reflect` claims each file before adopting it, under a name
carrying its journal's key, and records which journal that key stands for. A
claim cut off part-way is settled, once ten minutes old, against the journal
it names: removed if that journal took the file in, adopted if it did not or
the journal is gone. When that journal cannot be read, the claim is reported
and left until it can; a failed adoption that cannot read its own journal
marks its claim due at once. `park` settles its own worktree's claims first,
and `revise`, `drop` and `contribute` first finish the adoptions their journal
already holds part of, so a send mark is always read from the journal.
Parking
runs even with reflection off, on the journal the section still names beside
`enabled: false`, so findings noted while it was on are kept. A removal hook runs it and refuses the removal when it fails
([M12's worktree hooks](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/templates/worktree-hooks.md)).

## Escalation

`reflect` escalates only findings this repository owns: its tracker is where
their fix is tracked. A finding about a shared tool is stored as it is, and
escalated by `review-reflections` run in that tool's repository, against that
repository's tracker.

For a class with an open tracker issue labelled
`<issue_tracker.labels.pattern_prefix><class>` (`pattern:narrow-fix-per-round`
by default) that is this repository's own, a new finding of that class owned by this repository is stored
with an `escalated` decision naming the issue, and a comment on the issue
lists it. The issue is found through the repository's
[tracker interface](https://github.com/docomply/jig/blob/main/GLOSSARY.md).
The label is shared by every repository filing into the tracker's team, so it
does not say whose issue it is: the issue carries an
[owner marker](https://github.com/docomply/jig/blob/main/GLOSSARY.md), the
line `Jig owner: <owner>` with the owner percent-encoded, in its description
(the plan's `owner_marker`, written when the issue is filed), and only an
issue with the asking owner's marker counts. An issue without it, such as one filed before the marker existed, is
not attached to, and the next escalation files a new one. When there is no such issue and the
class's recurrence count, counting the new findings, reaches
`reflection.escalate_after` (default 3), the agent files one
(`issue_tracker.file_command`) and every open finding of the class this
repository owns is escalated to it. Another owner's findings of the same class
are left in that owner's queue. A closed tracker issue does not count: the
class recurring after its fix closed is a new escalation, and the new issue
links the closed one. Without a configured tracker, escalation is reported to
the person instead. Each tracker call has 60 seconds. At that deadline the
call is cancelled: the request in flight ends and no further page or request
starts. A lookup cut off this way leaves the class unverified, so no issue is
filed for it.

## The store contract

A store is a command that takes an operation as an argument (appended after
the command's own words), reads JSON or JSONL on standard input, and writes
JSON or JSONL on standard output. The built-in stores are implemented
through the same contract, so the conformance suite that checks them checks
any other.

| Operation | Input | Output | Guarantees |
|-----------|-------|--------|------------|
| `check` | none | `{"ok":true}`, or `{"ok":false,"reason":…,"fix":…}` | Says whether the store is reachable and writable, and how to fix it when not |
| `append` | JSONL events | `{"stored":[{"id":…,"ref":…}]}` | Every event is stored, or none is reported stored that was not. An `append` that repeats a stored id may store it again; neither it nor a concurrent `append` loses another event. `ref` is a reference a person can open, or `null` |
| `list` | `{"since":…}` (optional) | JSONL events | Every event, or every event at or after `since`, each id once: copies of one event are returned as one, and of different events under one id, the one whose stored text sorts first. A store may ignore `since` and return all. It never returns a ranked, capped or partial set: when it cannot read everything, it exits non-zero |
| `diagnose` | none | JSONL notices | What the store holds that disagrees with the events as `list` returns them, one notice per line: `{"kind":"id-conflict","id":…,"copies":[{"ref":…,"text":…}]}` for different events under one id, and `{"kind":"status-edited","ref":…,"shown":…,"computed":…}` for a status a person changed by hand where a store shows one. A store with neither returns nothing |

Exit codes: 0 done; 1 failed (the reason on standard error); 2 usage; 3
unavailable (unreachable, or not signed in), which `reflect` treats as "keep
the findings in the journal" rather than an error.

**Deadlines.** The caller runs every operation under
`reflection.timeout_sec` (default 120 seconds), and `list` and `diagnose`
under five times that, since they read the whole store; when the deadline
passes, the caller stops the store command and everything it started, then
treats the operation as unavailable. A store bounds its own retries to fit
inside that deadline. An `append` cut off part-way is safe to repeat: ids are
fixed before the first attempt, and the journal still holds every finding not
yet marked contributed.

A store must not change an event it returns: `list` gives back each event as
`append` received it. What a store shows people beside the events is its own
business.

**The conformance suite** checks a store command against all of this:

```sh
bun <skill-dir>/scripts/store-contract.ts --command "<command> <its options>"
```

Point the command at a fresh, empty store. The suite appends findings and
decisions, re-appends the same events, runs concurrent appends whose events overlap, appends a different
event under a stored id both one after the other and concurrently, lists,
checks the round trip byte for byte, that each id comes back once and that a
conflict returns the copy whose text sorts first, that `since` loses nothing,
that `diagnose` reports each conflict with every copy's text, the exit code
for an unknown operation, and that an invalid event is refused with the store
unchanged.

## Filesystem store

The default store (`reflection.store: filesystem`): a folder of JSONL files,
`reflection.path`, by default `~/.jig/reflections`.

- **One file per run, never changed.** Each `append` writes one new file,
  `<path>/<year>-<month>/<time>-<16 random hexadecimal digits>.jsonl`: written
  under a temporary name in the same folder, then linked into place without
  replacing a file already there, so a reader never sees half a file and no
  write removes another's. Nothing is appended to an existing file, edited or
  deleted. On a filesystem without hard links (a memory card's, many network
  shares), the temporary file is renamed into place instead, which also shows
  a reader only the whole file; it is refused when a file of that name
  exists, and only another writer drawing the same 16 random digits in that
  instant could slip in between.
- **No conflicts, no locks.** Every file name is unique, so sessions in
  different repositories and worktrees writing at the same time never touch
  the same file. A folder synced between machines (a cloud-drive folder) or
  kept in a git repository merges without conflicts for the same reason. Jig
  does not commit or push such a repository; a person or a scheduled job does.
- **`list`** reads every `.jsonl` file under the folder, skipping temporary
  names, and returns each id once. A line that is not a valid event, or a
  symbolic link anywhere under the folder, is an error naming the file and
  line or the link: a store that cannot be read whole is not read at all.
- **`diagnose`** reports each id stored with different events, naming the files
  and lines.
- **`check`** confirms the folder exists (or can be created) and is writable.
- **`ref`** is the file's path and line.
- **Privacy.** The folder holds findings from every repository that writes to
  it. A folder shared with a team mixes the content of every repository in it,
  so share it only among people who may see all of them.

## Notion store

`reflection.store: notion` keeps the reflections in a Notion database that
people browse, filter and sort, while the skills read and write the same
events as with any other store. A team that already triages its work in
Notion sees the findings there instead of in a folder of files.

**Setup.** In Notion, create an *internal integration* (a connection that
belongs to your workspace and acts through a secret key, at
[notion.so/profile/integrations](https://www.notion.so/profile/integrations))
and share a page with it (the page's ••• menu → Connections). Export the
integration's secret as `NOTION_TOKEN`, then create the database under that
page:

```sh
bun <skill-dir>/scripts/notion-store.ts init --parent <page id or link>
```

It creates the database with its properties and views (*All changes*,
*Inbox* and *By status*), and prints the setting to add:

```yaml
reflection:
  store: notion
  notion:
    database: <database id or link>
```

Those are the two settings: the token, read only from the environment and
never from a file, and the database. `check` reports a missing or refused
token, a database the integration cannot see, a database `init` did not
create, and a database missing properties, each with its fix. It cannot
confirm the integration may write: Notion does not expose an integration's
capabilities, and a probe would edit the database on every check. An
integration without insert or update capabilities fails at its first
`append`, with Notion's message. The store does not adopt a database it did
not create.

- **Through Notion's REST API.** The store is a script that runs outside the
  agent, so it calls Notion's public API with the integration's token, not
  the agent's own Notion connection. It pins the API version it is tested
  against (`2026-03-11`). Every database query and block listing is read
  page by page to its end, so `list` reads everything or fails; content is
  only ever added to a page, never rewritten.
- **One page per change.** A page per issue key (else branch) per
  repository, titled `[<repository>] <issue or branch>: <first finding's
  title>`. Each `append` adds a section at the end of the page: a heading with
  the time, the session as a callout (harness, model, Jig version, skills),
  and each finding as readable text. A decision adds a review note under its
  finding. A decision about a finding the database does not hold goes to a
  page of its own.
- **The record is in the page.** Below each finding and each decision, in a
  collapsed toggle named *Record*, is its event as a JSON code block
  captioned `jig reflection event`. `list` reads events from these blocks and
  nothing else, so editing the prose, the title or the properties changes
  nothing the skills see. A captioned block that does not hold a valid event
  is an error naming its page and block: a store that cannot be read whole is
  not read at all.
- **Properties are a view.** Status, Severity (the highest), Classes,
  Components (the targets), Repository, Issue, Branch, Pull request, Skills,
  Harness, Model, Jig version, Sessions, and First and Last reflected are
  recomputed from the events after every write, against the whole store's
  [computed state](#computed-state), on every page the write touched and
  on every page whose computed properties differ from the ones last written
  to it. A page keeps a digest of those in a property no view shows,
  *Computed properties*, so finding the pages that are behind takes no
  extra request.
  Events carry no session id, so Sessions counts the distinct session
  setups (harness, model, Jig version, skills and mode) behind the page's
  events. A multi-select shows at most a hundred options; the events keep
  the rest. A page's Status is *Inbox* while any
  finding on it has no decision, *Approved* while any is approved but not
  yet merged, and otherwise its latest decision, so filters and boards on
  Status work. A property write that fails leaves the events stored and says
  so on standard error; the next append, of any event, or
  `notion-store.ts --database <id> repair` recomputes them.
- **A status changed by hand is kept and surfaced.** The store also writes
  the Status it computed to a property no view shows, *Computed status*.
  Before every property update, `repair` included, a Status that differs from
  it was changed by hand: the update leaves Status as the person set it and
  updates the rest, and `diagnose` reports the page (`status-edited`, with
  the shown and the computed Status and the page's findings) until the person
  records the change as a decision (`review-reflections` asks) or puts it
  back. It is never silently overwritten or silently obeyed.
- **Retries and races are harmless.** `append` reads the store before
  writing and does not write an event whose exact text is already there, so
  a retried append adds nothing. A write Notion answers with a server
  error may have been applied, so it is not sent again: the append reads as
  unavailable, and running it again finishes it. A read (a database query
  too, though Notion's API sends it as a write request) is retried on a
  server error. Two concurrent writers can still both add
  one, and `list` returns it once; `diagnose` reports different events under
  one id, on any page. Two sessions that create a page for the same change at
  the same moment leave two pages; since state comes from events, `list`
  merges them, and later writes go to the older page. A page's change is the
  hidden *Change key* property.
- **Fast enough to review often.** `list` keeps a cache in
  `~/.jig/cache/notion/<database>.json` (under `JIG_HOME`), keyed by each
  page's last-edited time, so a review re-reads only the pages that changed
  since the last one. Notion keeps that time only to the minute, so a page
  edited in the last five minutes is never taken from the cache. The cache
  is saved while a read goes on, so a read cut off by its deadline is
  continued by the next. Requests
  start at least 340 milliseconds apart (Notion allows an average of three a
  second) and honour `Retry-After` when Notion asks to wait; a rate limit or
  a server error that outlasts six attempts, or a wait longer than a
  minute, reads as unavailable. `JIG_NOTION_API_URL`, which points the store
  at another endpoint, must be https, or http to this machine.
- **`ref`** is a link to the page, or to the record's toggle on it.
- **Exit codes.** 3 (unavailable) for a missing or refused token, or Notion
  out of reach; 1 for anything Notion refused, such as a database the
  integration cannot see.
- **Privacy.** The database holds the findings of every repository that
  writes to it, and everyone it is shared with sees all of them. A page
  moved to Notion's trash takes its events out of the store.
- **Conformance.** The Notion store passes the conformance suite and the
  behaviour above.

## Command store

`reflection.store: command` runs `reflection.command` (a list of words, or a
line split on spaces with quotes keeping words together; no shell runs it) as
the store, with the operation appended. That is how a repository or a person
plugs in a store of their own; run the conformance suite against it first.

## Where reflection is asked for

Only when reflection is on; when it is off nothing below happens.

| Where | What it does |
|-------|--------------|
| [`drive-pr`](../drive-pr/README.md) | `drive-status.ts` reports `reflectDue`, and `drive.ts` arms `$DRIVE_PR_REFLECT_DUE`, when the review rounds since the last reflection pass the threshold; the pass runs `/jig:reflect` and records it with `drive-state.ts set-reflected` |
| [`resolve-review-comments`](../resolve-review-comments/README.md) | `await-round.ts`, at wind-down after a pull request took more than `REFLECT_THRESHOLD` rounds, notes the round count in the journal (a `review-took-many-rounds` finding with an id derived from the pull request) and asks for `/jig:reflect`; the drive's rounds pass through it too |
| [`do-item`](../do-item/SKILL.md) | Asks for `/jig:reflect` when a recurring pattern scout finds a class of problem |
| [M12 worktree removal](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/templates/worktree-hooks.md) | The removal hook asks for `/jig:reflect` and runs `journal.ts park`, refusing the removal when parking fails |

## Scripts

| Script | What it does |
|--------|--------------|
| `scripts/journal.ts` | `note`, `revise`, `drop`, `unsent`, `park`, `path`: capture in the worktree's journal |
| `scripts/reflect.ts` | `status`, `gather`, `plan`, `contribute`: the script half of the procedure |
| `scripts/store.ts` | One store operation against the configured store, under its deadline |
| `scripts/filesystem-store.ts` | The filesystem store, behind the contract |
| `scripts/notion-store.ts` | The Notion store, behind the contract, with `init` and `repair` |
| `scripts/store-contract.ts` | The conformance suite |

## Left out

- **Commit statistics** (commits per hour, files changed repeatedly, the share
  of commits with tests) in comprehensive mode: plausible signals, not yet
  shown to change a decision.
- **Compacting old store files** into fewer files: unnecessary until a store is
  large enough for `list` to be slow.
- **Moving an existing store** to another kind: a store is chosen once, and
  emptied or finished by hand before a change.
- **Running the reflection from the removal hook.** A hook is a script and
  cannot run an agent's reflection; it parks the journal and asks for one.
