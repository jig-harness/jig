# Session reflection: design

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

This is the runnable form of the reflection cycle in
[M8](../modules/M8-learning-loop/README.md). It is planned work:
[ROADMAP.md](../ROADMAP.md) items 7 (the skills, the filesystem store and the
store contract) and 8 (the Notion store).

Contents: [the loop](#the-loop) · [events](#events) ·
[computed state](#computed-state) · [the journal](#the-journal) ·
[`reflect`](#reflect) · [`review-reflections`](#review-reflections) ·
[configuration](#configuration) · [the store contract](#the-store-contract) ·
[filesystem store](#filesystem-store) · [Notion store](#notion-store) ·
[Jira store (future)](#jira-store-future) ·
[where reflection is asked for](#where-reflection-is-asked-for) ·
[left out](#left-out)

## The loop

1. **Capture.** While a session works, a finding goes into the session's
   [journal](#the-journal), a file in its own worktree. A skill can write one
   itself (the drive records a review that took many rounds); the agent writes
   one when something goes wrong.
2. **Reflect.** At a natural end (a converged drive, an addressed review, the
   end of a session, before a worktree is removed), [`reflect`](#reflect)
   reads the journal, adds what the session itself observed, merges
   duplicates, names each finding's class, and decides what to contribute.
3. **Store.** The contributed findings go to the shared
   [store](#the-store-contract): a folder, a Notion database, or any other
   store behind the same contract. Every repository on the machine (or in the
   team) contributes to the same store.
4. **Review.** Periodically, [`review-reflections`](#review-reflections)
   reads the store, groups the open findings, proposes changes, and asks a
   person to approve them. Approved changes are made through ordinary pull
   requests.
5. **Close.** Each decision is recorded in the store. A fix counts as
   implemented only once it is merged.

A class of finding that keeps recurring is not filed again: it is
[escalated](#escalation) to one tracker issue that asks for a structural fix.

## Events

The store holds an append-only log of events. Nothing is edited after it is
written; everything that looks like state (a finding's status, the highest
severity of a change) is [computed](#computed-state) from the events when the
log is read. That is what lets a store be a plain folder, and what keeps a
half-finished write from leaving the record inconsistent.

The rule every part of this design keeps: **computed state depends only on
the set of distinct events.** It does not depend on which store holds them,
the order a store returns them in, how many copies of one event a store
holds, or which of two concurrent writers finished first. And a finding
leaves the journal only once the store has it.

There are two kinds of event, each one JSON object, written one per line in
the [JSONL](../GLOSSARY.md) format:

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
  "jig_version":"0.14.0",
  "skills":["drive-pr","resolve-review-comments"],
  "harness":{"name":"claude-code","version":"2.4.1","entrypoint":"sdk-ts","wrapper":"conductor"},
  "model":"claude-opus-5-5",
  "mode":"quick",
  "stated":["model","skills"]
}
```

- **`jig_version`** is read from the plugin's own manifest.
- **`harness`** is read from the environment the harness sets: Claude Code
  sets `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`, and a wrapper that runs the
  harness (Conductor, for example) adds its own variables. A harness that
  sets none is stated by the agent.
- **`model`** is stated by the agent: no harness exposes it to a script.
- **`skills`** are the skills the session used, as the agent knows them;
  a skill that writes to the journal itself adds its own name.
- **`stated`** lists the fields the agent supplied rather than the script
  reading them, so a reader knows which values are reported and which are
  measured. A value nobody knows is `null`, never a guess.
- The event's `at` is the time it was written, in Coordinated Universal
  Time.

With these, the store answers questions such as "which classes rose after
plugin 0.14.0" or "does this class occur under one harness only", so a
regression after a release or a model change shows up as a change in a class's
rate.

### Ids

The writer creates each event's id before the first attempt to store it: the
time and 16 random hexadecimal digits, so ids sort by time and two writers
never pick the same one. A retry after a timeout, or two concurrent writes,
can store one event twice; `list` returns each id once
([the store contract](#the-store-contract)), so a finding is never counted
twice. An event a script writes for a fact that can recur (the drive's round
count for one pull request) takes an id derived from that fact instead, so
re-running the script cannot record it twice; the fact includes the repository
and the change, so a derived id is never shared between changes either.

Two different events under one id mean a writer is wrong, and no store
check can rule that out: two concurrent writers can each find the id absent.
So a store does not try to refuse one at write time. `list` settles it the
same way every time, returning the copy whose stored text sorts first, and
`diagnose` reports the conflict with every copy. The store stays readable, and
a person sees the conflict. Everything computed or shown from the events
agrees with `list`; where a conflict makes a store show something else,
`diagnose` reports that too.

## Computed state

| Question | Answer, from the events |
|----------|-------------------------|
| A finding's status | Its latest decision; `open` when it has none. Decisions are ordered by `at`, then by `id`, so two decisions written in the same second still have one latest, whatever order a store returns them in |
| Open findings | Status `open`, or `approved` without a merged commit |
| A change's severity | The highest severity among its findings. Nothing is overwritten, so it goes down only when an [id conflict](#ids) replaces a finding, which `diagnose` reports |
| A change's components and skills | The union over its findings |
| A class's recurrence count | Per owner (below): the owner's findings of that class that are `open` or `deferred`. Each occurrence is its own finding, so a recurring problem raises the count; a deferred finding is still evidence the problem recurs |

A finding's **owner** is where a fix for it would be made: for
`scope: repository`, the repository (`change.repository`); for `scope: tool`,
the tool (`target.tool`). Two repositories' `AGENTS.md` findings have
different owners; findings about one Jig skill from any repository share
one. Recurrence counts, grouping and escalation are all per owner.

Because state is computed, a store never has to keep a status, a count or a
severity in step with anything. A store that also shows such values to people
(the Notion store's properties) computes them from the events and treats them
as a view.

## The journal

Each worktree has a journal: a JSONL file git never tracks, by default
`<git-dir>/jig/reflection-journal.jsonl`. In a linked worktree the git
directory is the worktree's own, so each worktree has a separate journal and
removing the worktree removes it. `reflection.journal` moves it, for example
to a scratch folder the repository ignores; `reflect` refuses a path git
would track.

The journal holds finding events not yet in the store, and two kinds of line
about them: `contributed` (the id, and the link the store returned) and
`dropped` (the id and why `reflect` kept it out of the store). Lines are only
appended. Writing to the journal needs no network, no lock and no
configuration beyond the switch, so capturing a finding never fails because
the store is unreachable. When the store is unreachable at `reflect` time, the
findings simply stay in the journal until the next `reflect` sends them.

`bun <plugin>/skills/reflect/scripts/journal.ts note` appends a finding (the
event on standard input, the session block filled in), and is what skills and
agents call to capture.

## `reflect`

1. **Gather.** The journal's findings that are neither contributed nor
   dropped, those a removed worktree of the same repository left in
   `~/.jig/pending/` ([where reflection is asked for](#where-reflection-is-asked-for)),
   and what the session itself observed. Quick mode (the default)
   asks only what went wrong or cost time; comprehensive mode also asks what
   worked, what could improve, and which skill outputs needed iteration.
2. **Merge.** Findings in the journal that describe the same incident (one
   event noted twice, by a skill and by the agent) become one, keeping the
   earliest id; the others are marked `dropped` with the id they merged into.
   Two incidents of the same problem stay two findings: each is evidence of
   recurrence.
3. **Name the class.** The store's classes in use come from `list`. A class
   whose shape fits is reused by name; a new class needs a one-sentence shape.
4. **Decide what to contribute.** A finding is contributed when it is about
   the scaffolding (not the product) and actionable. An open finding of the
   same class and target already in the store does not keep it out: it is
   another occurrence, which [`review-reflections`](#review-reflections)
   groups with the first. The rest are marked `dropped` with the reason. In an attended session the person sees the list
   before anything is stored; in an unattended one (a drive), `reflect`
   proceeds and the review is where a person filters.
5. **Escalate or file**, for the findings being contributed only: a dropped
   finding neither counts toward recurrence nor touches the tracker. See
   [escalation](#escalation).
6. **Store.** `append` the contributed findings; mark each `contributed` in
   the journal with the link the store returned.
7. **Report** what was stored, escalated, dropped or left in the journal.

### Escalation

`reflect` escalates only findings this repository owns (see
[computed state](#computed-state)): its tracker is where their fix is
tracked. A finding about a shared tool is stored as it is, and escalated by
`review-reflections` run in that tool's repository, against that
repository's tracker.

For a class with an open tracker issue labelled
`<issue_tracker.labels.pattern_prefix><class>` (`pattern:narrow-fix-per-round`
by default) in this repository's tracker, a new finding of that class owned
by this repository is stored with an `escalated` decision naming the issue,
and a comment on the issue links it. The issue is found through the
[tracker interface](../GLOSSARY.md). When there is no such issue and the
class's recurrence count for this repository, counting the new finding,
reaches `reflection.escalate_after` (default 3), `reflect` files one
(`issue_tracker.file_command`, or the tracker adapter where it can file), and
escalates every open finding of the class that this repository owns to it.
Another owner's findings of the same class are left in that owner's queue. A tracker issue that is closed does not count: the class recurring after
its fix closed is a new escalation, and the new issue links the closed one.
Without a configured tracker, escalation is reported to the person instead.

## `review-reflections`

1. **Load.** `list` the store. The findings in scope are those whose `target`
   is this repository (`scope: repository` and this repository's
   `change.repository`) or a tool this repository is (run in the Jig
   repository, every finding about a `jig` skill, from every repository).
   `--class`, `--target`, `--severity` and `--since` narrow it. Then
   `diagnose` the store. A `status-edited` notice is a status a person
   changed by hand where the store shows it; the review shows it beside its
   finding and asks the person to record it as a decision or to put the shown
   status back. An `id-conflict` notice names a writer that reused an id; the
   review shows each copy's text and which one `list` returned. A
   `diagnose` that fails is reported, and the review goes on from the events.
2. **Reconcile.** An `approved` finding whose commit is now reachable from the
   integration branch gets an `implemented` decision. A squash merge is
   followed to the commit that landed. A check that cannot be completed (the
   remote unreachable, a pull request that cannot be read) leaves the finding
   `approved` and is reported; it is never read as "not merged".
3. **Group** open findings by owner, class and target, newest first, with
   counts. A group's count is how often the problem recurred.
4. **Propose** an action per group: a concrete change to a named file
   (approve), defer, dismiss with a reason, or escalate.
5. **Approve.** A person approves, edits or rejects each proposal. Nothing is
   changed without approval: the rules agents follow are changing themselves,
   which is human-in-the-loop by construction
   ([M8](../modules/M8-learning-loop/README.md)).
6. **Implement** the approved changes in a pull request, through `do-item`'s
   pull-request policy.
7. **Record** a decision event per finding: `approved` with the commit and
   pull request, or the disposition and its reason. Escalation here works as
   in [`reflect`](#escalation), for the owners in scope: run in the Jig
   repository, it escalates findings about Jig's skills to Jig's tracker.

## Configuration

```yaml
# ~/.jig/jig.yaml: on for every repository on this machine
reflection:
  store: filesystem                # filesystem | notion | command
  path: ~/.jig/reflections         # filesystem store
```

| Field | Default | What it does |
|-------|---------|--------------|
| `reflection` | absent: reflection is off | The section's presence, in any [configuration layer](../plugin/CONFIGURATION.md#configuration-layers), turns reflection on |
| `reflection.enabled` | `true` when the section exists | `false` turns it off: in a repository's file for that repository, or `JIG__REFLECTION__ENABLED=false` for one run |
| `reflection.store` | `filesystem` | Which store answers |
| `reflection.path` | `~/.jig/reflections` | The filesystem store's folder |
| `reflection.notion.database` | none | The Notion store's database |
| `reflection.command` | none | The command a `command` store runs |
| `reflection.journal` | `<git-dir>/jig/reflection-journal.jsonl` | The worktree's journal |
| `reflection.escalate_after` | `3` | Recurrence count at which a class is escalated |
| `reflection.timeout_sec` | `120` | The deadline for one store operation; `list` and `diagnose` get five times as long |
| `reflection.mode` | `quick` | `reflect`'s default mode |

Since the store is shared by every repository, `reflection` is normally set in
the user layer, which turns reflection on in every repository on that
machine: reflection is a person's choice first. A repository turns it on for
everyone who works in it by adding the section to its own file, and the
section there can override the user's store.

## The store contract

A store is a command that takes an operation as its first argument, reads
JSON or JSONL on standard input, and writes JSON or JSONL on standard output.
The built-in stores are implemented through the same contract, so the
conformance suite that checks them checks any other.

| Operation | Input | Output | Guarantees |
|-----------|-------|--------|------------|
| `check` | none | `{"ok":true}`, or `{"ok":false,"reason":…,"fix":…}` | Says whether the store is reachable and writable, and how to fix it when not |
| `append` | JSONL events | `{"stored":[{"id":…,"ref":…}]}` | Every event is stored, or none is reported stored that was not. An `append` that repeats a stored id may store it again; neither it nor a concurrent `append` loses another event. `append` reads no more of the store than its own target (a file, a page) needs. `ref` is a link a person can open, or `null` |
| `list` | `{"since":…}` (optional) | JSONL events | Every event, or every event at or after `since`, in any order, each id once: copies of one event are returned as one, and of different events under one id, the one whose stored text sorts first. A store may ignore `since` and return all. It never returns a ranked, capped or partial set: when it cannot read everything, it exits non-zero |
| `diagnose` | none | JSONL notices | What the store holds or shows that disagrees with the events as `list` returns them, one notice per line: `{"kind":"status-edited","ref":…,"shown":…,"computed":…}` for a status changed by hand, `{"kind":"id-conflict","id":…,"copies":[{"ref":…,"text":…}]}` for different events under one id, with each copy's stored text and where it is. A store with neither returns nothing |

Exit codes: 0 done; 1 failed (the reason on standard error); 2 usage; 3
unavailable (unreachable, or not signed in), which `reflect` treats as "keep
the findings in the journal" rather than an error.

**Deadlines.** The caller runs every operation under
`reflection.timeout_sec`, and `list` and `diagnose` under five times that,
since they read the whole store; when the deadline passes, the caller stops the store command and
everything it started, then treats the operation as unavailable (exit 3).
A store bounds its own retries to fit inside that deadline. An `append` cut
off part-way is safe to repeat: ids are fixed before the first attempt, and
the journal still holds every finding not yet marked `contributed`.

A store must not change an event it returns: `list` gives back each event as
`append` received it. What a store shows people beside the events (pages,
properties, issues) is its own business.

The conformance suite (`store-contract.ts --command "<command>"`) appends,
re-appends the same events, runs concurrent `append`s whose events overlap,
appends a different event under a stored id, both one after the other and
concurrently, lists, checks the round trip byte for byte, that each id comes
back once and that a conflict returns the copy whose text sorts first, checks
that `diagnose` reports each conflict with every copy's text, and checks the exit codes, against a
fresh store the command is pointed at.

## Filesystem store

The default store: a folder of JSONL files.

- **One file per run, never changed.** Each `append` writes one new file,
  `<path>/<year>-<month>/<time>-<16 random hexadecimal digits>.jsonl`, a name
  of its own rather than one taken from its events: written under a temporary
  name in the same folder, then moved into place without replacing a file
  already there, so a reader never sees half a file and no write removes
  another's. Nothing is appended to an existing file, edited or deleted.
- **No conflicts, no locks.** Every file name is unique, so sessions in
  different repositories and worktrees writing at the same time never touch
  the same file. A folder synced between machines (a cloud-drive folder) or
  kept in a git repository merges without conflicts for the same reason. Jig
  does not commit or push such a repository; a person or a scheduled job
  does.
- **`append`** writes its events to its own file and reads nothing else, so
  a retried or concurrent `append` can store one id in two files; `list`
  returns it once.
- **`list`** reads every `.jsonl` file under the folder, skipping temporary
  names, and returns each id once. A line that is not a valid event is an
  error naming the file and line: a store that cannot be read whole is not
  read at all.
- **`diagnose`** reports each id stored with different events, naming the
  files and lines; the folder shows people nothing else.
- **`check`** confirms the folder exists (or can be created) and is writable.
- **`ref`** is the file's path and line.
- **Privacy.** The folder holds findings from every repository that writes to
  it. A folder shared with a team mixes the content of every repository in
  it, so share it only among people who may see all of them.

## Notion store

Keeps reflections in a Notion database that people browse, filter and sort,
while the skills read and write the same events as any other store. It ships
with the plugin as `reflection.store: notion` and works from two settings.

- **Setup.** Create an internal integration in Notion and share a page with
  it. Then `notion-store.ts init --parent <page>` creates the database, its
  properties and its views, and prints the setting to add:

  ```yaml
  reflection:
    store: notion
    notion:
      database: <database id or link>
  ```

  The integration's secret is read from `NOTION_TOKEN`, never from a file.
  `check` reports a missing token, a database the integration cannot see, or
  a database missing properties, each with its fix.
- **Through the REST API.** The store is a script that runs outside the agent,
  so it calls Notion's public API with the integration's token, not the
  agent's own Notion connection. That API pages every database query and
  block listing with a cursor (`has_more`, `next_cursor`), which is what lets
  `list` read every page or fail, and it adds content to a page with an
  append-only call, so a write never rewrites the page body. The store pins
  the API version it is tested against.
- **One page per change.** A page per issue key (else branch) per repository,
  titled `[<repository>] <issue or branch>: <summary>`. Each `reflect` adds a
  section: a heading with the time, the session block as a callout (harness,
  model, Jig version, skills), and each finding as readable text. A decision
  adds a review note under its finding.
- **The record is in the page.** Beside each finding and each decision, in a
  collapsed toggle, is its event as a JSON code block. `list` reads events
  from these blocks and nothing else; editing the prose changes nothing the
  skills see.
- **Properties are a view.** Status, Severity, Classes, Components,
  Repository, Issue, Branch, Pull request, Skills, Harness, Model, Jig
  version, Sessions, First and Last reflected are recomputed from the page's
  events after every write; `repair` recomputes them from the events as
  `list` returns them, so an [id conflict](#ids) settled across pages reaches
  each page, and until then `diagnose` names the pages among the conflict's
  copies. The page Status is `Inbox` while any finding on it
  has no decision, `Approved` while any is approved but not yet merged, and
  otherwise the latest decision, so filters and boards on Status work. A
  property write that fails leaves the events correct; the next write, or
  `notion-store.ts repair`, recomputes the properties.
- **A status changed by hand is kept and surfaced.** The store also writes
  the Status it computed to a hidden property. Before every property update,
  `repair` included, a Status that differs from that hidden one was changed
  by hand: the update leaves Status as the person set it, updates the rest,
  and `diagnose` reports the page until the person records the change as a
  decision (`review-reflections` asks) or puts it back. It is never silently
  overwritten or silently obeyed.
- **Retries and races are harmless.** `append` reads the events on the
  change's page before writing, so a retried event is not added there twice;
  two concurrent writers can still both add one, and `list` returns it once.
  `diagnose` reports different events under one id, on any page. Two sessions
  that create a page for the same change at the same moment leave two pages;
  since state comes from events, `list` merges them by change and later
  writes go to the older page.
- **Fast enough to review often.** `list` keeps a cache in
  `~/.jig/cache/notion/<database>` keyed by each page's last-edited time, so a
  review re-reads only the pages that changed since the last one. Requests
  stay within Notion's rate limit (an average of three a second) and honour
  `Retry-After`.
- **Tested without Notion.** The tests run the conformance suite against a
  local fake of the API endpoints the store uses. A run against a live
  scratch database is opt-in, with a token.

A database must have been created by `init`: the store does not adopt a
database it did not create.

## Jira store (future)

Not planned yet; the shape a Jira store would take, for when a team that
tracks its work in Jira needs one.

- **One issue per finding,** of a custom issue type (`Agent feedback`) in a
  project the configuration names. A finding is the unit a Jira workflow
  decides on, where Notion groups findings by change for reading.
- **Fields:** custom fields for Class, Severity, Target, Repository, Branch,
  Pull request, Harness, Model, Jig version and Skills, so Jira's own
  filters, boards and dashboards work on them; the change's issue key as an
  issue link.
- **The record:** the finding's event as an issue property (JSON stored on
  the issue, not shown in its fields), and each decision as a comment carrying
  its event. `list` reads the properties and comments; the workflow status is
  a view, kept in step by transitions the store makes after recording each
  decision, with the same hand-edit rule and the same handling of an
  [id conflict](#ids) as the Notion store.
- **Idempotency:** every event's id, a decision's included, in a searchable
  field of the issue that holds it, looked up before writing, so a retry does
  not create a second issue. Two concurrent writers can both create one;
  `list` returns the event once, and the store links the later issue to the
  earlier as a duplicate.
- **Escalation** to an issue in the same Jira links the escalated findings
  to it, so the tracker shows the recurrence directly.
- **Open questions:** whether a project administrator must create the issue
  type and fields (the store's `init` cannot on every Jira plan), and how
  `list` stays complete within Jira's search paging limits on a large project.

## Where reflection is asked for

Only when reflection is on; when it is off nothing below happens, and the
scripts, not the instructions, decide that.

| Where | What it does |
|-------|--------------|
| `drive-pr` | `drive-status.ts` reports `reflectDue` when the review rounds since the last reflection pass the threshold; the pass runs `reflect` and records it. It also notes a hard-won convergence (the round count) in the journal |
| `resolve-review-comments` | `await-round.ts` asks for `reflect` at wind-down when a pull request took more than `REFLECT_THRESHOLD` rounds |
| `do-item` | Asks for `reflect` when a recurring pattern scout finds a class of problem |
| M12 worktree removal | The removal hook runs `reflect` before the worktree, and its journal, are removed. When findings remain neither contributed nor dropped (the store unavailable), the hook moves them to `~/.jig/pending/` (under `JIG_HOME`), which the next `reflect` in any worktree of the same repository sends, before it removes the worktree; if it cannot, it refuses the removal |

## Left out

- **Commit statistics** (commits per hour, files changed repeatedly, the
  share of commits with tests) in comprehensive mode: plausible signals, not
  yet shown to change a decision.
- **Compacting old store files** into fewer files: unnecessary until a store
  is large enough for `list` to be slow.
- **Moving an existing store** to another kind: a store is chosen once, and
  emptied or finished by hand before a change.
