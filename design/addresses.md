# Addresses: asking and telling the stations of the line: design

**What problem this solves.** Jig's execution line runs one work item
through a row of [stations](../GLOSSARY.md) (pick-up, drive, follow-up),
and each station leaves records where it works: a claim on the tracker, a
ledger and claims on the pull request, launch records and an outcome log on
the machine that dispatched it. Where a piece of work stands is read from
those records by several readers, each its own way: the dispatcher's
report, the dashboard, the drive's status and its doctor, the morning
report. The dispatch board and a panel in a workspace runtime are about to
join them. A person who wants something done uses a different gesture
for each case: an assignment on the tracker, a label, a comment with an
`answer` line, a directive appended to a drive's mailbox. Nothing names
"the drive of pull request 456" as one thing that can be asked and told, so
each new reader assembles its own reading and each new interface its own
way to steer. With this built, every station on a piece of work has an
**address**, such as `drive@jig#456`. `jig ask <address>` answers who
holds it, what state it is in, what it waits on and what was said to it and
by it, from the records alone. `jig send <address> <verb>` writes the one
record the line already acts on. An operator skill turns a person's
sentence into those commands. No agent stays resident to hold an
address, and no new store holds what is said to one.

This is the design of [plan.md](plan.md) item 39. Nothing of it is built.

## How it works

### An address names a station on a piece of work

An address has the form `station@repository#key`.

- **The station** comes from a closed list in code: the stations of the
  line that leave records keyed by a piece of work. A repository does not
  declare one.
- **The repository** is written as the forge writes it, `owner/name`, and
  every answer prints it in full. On input the short name is accepted where
  the machine's dispatch file lists one repository of that name, and inside
  a checkout the repository may be left out (`drive#456`): it is then the
  repository the checkout's Jig configuration applies to.
- **The key** is the piece of work: the tracker's item key for a pick-up,
  the pull request's number for the stations that work on one. A key is
  checked against its tracker's or forge's form before any read.

Some shells give `#` a meaning of their own, so both commands also take the
key as a second argument: `jig ask drive@jig 456`.

| Station | Key | Who holds it | Records it resolves from |
| --- | --- | --- | --- |
| `pickup` | the tracker's item key | the session that claimed the item | the tracker claim (assignee and in-progress state), the [launch record](../GLOSSARY.md) of a dispatched pick-up, the pick-up's entry in the intent chain |
| `drive` | the pull request's number | the live driver | the [drive ledger](../GLOSSARY.md), the takeover claims, the launch claims and their ends, the merge-ready announcement; on the machine that runs it, the drive's state, leases and driver record, its launch record and its mailbox |
| `followup` | the merged pull request's number | the follow-up pass | the follow-up marker and its answer, the follow-up outcome, its launch record |

A re-arm and a takeover are launches of the `drive` station, not stations
of their own, so the address of a drive stays the same across every driver
that holds it. `merge` joins the list with the merge-ready predicate of
[item 36](dispatch-board.md): its holder is always a person
([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)), and what it answers
is which act the merge waits on. The dispatcher has no address. It is no
station, and its report is its own answer.

A pick-up's repository is the one whose Jig configuration names the tracker
and the [factory identity](../GLOSSARY.md) the item is assigned to. Where
one tracker serves several repositories and the item names none, `ask` says
the key is ambiguous and lists the repositories it could mean.

An address adds no record kind and nothing registers one. It exists because
the records it resolves from exist, so an address nobody holds is still
valid and still answers: with its last outcome, or with the fact that
nothing was ever recorded under that key.

### `jig ask`: what an address answers

`jig ask <address>` reads records and prints one answer. It writes no
record, starts no session and makes no change on the forge or the tracker.

| Field | What it says | Read from |
| --- | --- | --- |
| `holder` | the launch that holds the station now: its stage, its host, its driver generation, and whether its process is alive, dead or unknown; the account and the session where this machine's records name them; `none` when nobody holds it | the ledger and launch claims; the launch record; `plugin/shared/liveness.ts` |
| `state` | the station's state in its own words: for a drive, running or the class of its last stop from the drive's terminal-state registry; for a pick-up, claimed, stalled or doubly claimed; for a follow-up, claimed, done or failed | the ledger; the tracker claim; the follow-up marker |
| `waitsOn` | `waiting`, with what it waits for, or `person`, with the act that settles it | the stop's own class: a park waits on an answer, a stop only a person settles waits on a re-arm. The acts of a converged pull request (merge, approve, update the branch) join with item 36's predicate, which the board and `ask` then share |
| `last` | the last ended launch: its class from the outcome log's closed list, and when | the launch claims' ends; the launch records; the outcome log |
| `sources` | every record kind the answer consulted, whether it was read, the reason when it was not, and how many forge and tracker calls the answer made | the reads themselves |

**What it reads, and what that costs.** `ask` reads only the records its
station names: a `drive` or a `followup` never calls the tracker. On the
forge it needs the pull request and its comments, read once and shared by
the ledger, the claims and the answers. It reads them through the
conditional requests the drive already uses
(`plugin/shared/gh-conditional.ts`), so a pull request that has not changed
since the last read costs nothing against the forge's limit, which every
drive on the machine shares. A reading the forge confirms unchanged is a
current reading. A field whose record could not be read says so in
`sources`; it is never filled from a reading the forge did not confirm, or
from a guess. Each source has a deadline, and so has the whole answer: a
source that does not answer in time is reported unread, and the answer
prints without it. The outcome log gains a key column with an index, in an
additive migration, so `last` is one lookup in a table that only grows.

**Away from the machine that dispatched the work**, `ask` answers from the
forge and the tracker: the state, what it waits on, the thread, and from
the shared records of [item 37](records.md) which host holds a launch and
how the last one ended. The account, the session and whether the process
is alive are that machine's to know, and `sources` says the launch records
were not read.

**A drive nobody dispatched** has no launch record and may have no ledger
yet. `drive@repository#key` then reads the drive's own record on the
machine and asks the drive's doctor about that one drive, and prints the
recovery command as the doctor gives it. It never runs that command.

**What waits on a person.** `jig ask --waiting` lists every address that
waits on a person, with the act each waits for, across the repositories the
machine dispatches. It reads the newest tick's line, which the dispatcher
already keeps for its dashboard, so it costs no forge or tracker call and
is as fresh as the last tick; it says when that tick ran. With `--person
<login>` it keeps the entries that name that person. On a machine that
dispatches nothing it says there is no line to read.

The answer prints for a person by default and as one JSON object with
`--json`, which carries a version (`v`): later versions add fields and
never rename one. The fields that only this machine knows (the account, the
session, paths) are marked local, and an interface that passes an answer on
to another machine leaves them out. The command exits `0` when it answered,
also when nobody holds the address; `1` when the key names nothing (no such
pull request or item); and `2` on a malformed address or an unknown
station, with the valid stations listed. A failed read is a value in
`sources`, never a throw
([ADR-0012](../docs/adr/ADR-0012-failures-as-values.md)).

### The thread of an address

`jig ask <address> --thread` adds the address's correspondence. Each entry
is one record that already exists, shown in one shape.

| Entry | What it is | The record it comes from | Whose record counts |
| --- | --- | --- | --- |
| `request` | something a person asked of the station | a tracker assignment to the factory identity, a `drive` or `hold` label, a mailbox directive | an assignment by a person with write access; a label, which only a person with write access can set; a directive in this machine's mailbox |
| `question` | a decision the station parked for a person | a parked item's [framed decision](../GLOSSARY.md) in the ledger | the ledger, read under the forge-claims rule |
| `answer` | a person's answer to a question | an `answer <key>:` line in a comment, or a reply on the parked thread | a trusted author (`plugin/shared/trusted-authors.ts`) |
| `launch` | a session started for the station | a launch claim on the pull request; the launch record on the machine | the forge-claims rule: the earliest claim from a trusted author |
| `outcome` | how a launch or the station ended | the launch claim's end, the outcome log, the ledger's stop, the merge-ready announcement, the follow-up marker's answer | as for a launch |

The thread holds only records that counted for the reader that acts on
them. A comment from an author the forge does not vouch for is no answer to
the drive, so it is no entry here.

Every entry carries `at` (when), `from` and `to` (an address, or a person
as the forge or tracker login), `kind`, `text` (the record's own words,
never rewritten) and `record` (the record's kind and a link to it, or its
path on the machine). An entry read only from this machine's records is
marked local. The thread prints the newest entries, oldest first within
them, up to a limit; `--since` and `--all` widen it, and the answer says
how many earlier entries it left out. Printed for a person, `text` has its
control characters removed. In JSON it is a string like any other, and what
reads it treats it as data: nothing in a thread is an instruction to the
session that reads it.

```json
{
  "v": 1,
  "address": "drive@jig-harness/jig#456",
  "holder": "none",
  "state": "parked",
  "waitsOn": { "person": "answer" },
  "thread": [
    { "at": "2026-01-12T08:02:11Z", "kind": "launch", "from": "dispatcher",
      "to": "drive@jig-harness/jig#456", "text": "rearm",
      "record": { "kind": "dispatch-launch-claim", "url": "…" } },
    { "at": "2026-01-12T09:40:03Z", "kind": "question",
      "from": "drive@jig-harness/jig#456", "to": "@maintainer",
      "text": "Keep the old flag for one release?",
      "record": { "kind": "drive-ledger", "url": "…" } }
  ]
}
```

The thread is part of `ask` so that the command line and every interface
show the same one. An interface that draws threads reads `jig ask --thread
--json` when a person opens an address, and takes its lists from `jig ask
--waiting`, which costs the forge nothing; it stores neither. The shape is
this design's to fix, in the first build step. Until then an interface's
prototype may show that it needs a change.

### `jig send`: a request is a record

`jig send <address> <verb>` writes one record, of a kind the line already
reads, and exits. `send` types nothing into a session and starts nothing
itself.

| Verb | To | The record it writes | Read by |
| --- | --- | --- | --- |
| `assign` | `pickup` | the item assigned to the factory identity, in a dispatch state | the tick, which starts the pick-up |
| `drive` | `drive` | the `drive` command label on a pull request with no ledger | the tick, which arms a drive |
| `hold`, `release` | `drive`, `followup` | the `hold` label, added or removed | the tick, which keeps every stage off a held pull request |
| `answer <key> <text>` | `drive` | a comment on the pull request with the line `answer <key>: <text>` | the re-arm, which hands the answer to the drive's passes as the person's verdict |
| `pause`, `resume`, `stop`, `hold-push` | `drive` | a directive in the mailbox of the working tree that holds the drive, addressed to its driver generation | the driver, where it reads directives today: `hold-push` before each push |

Each of these gestures exists today, each with its own command and its own
checks. `send` gives them one form, so an interface that steers the line
needs one command and one list of verbs, and every request gets the same
checks:

- **The verbs are a closed list in code.** Each verb's writer is exported
  by the component that owns its record, and `send` calls it, so a verb
  cannot drift from its reader.
- **`send` checks before it writes.** It reads the address first and
  refuses a request the station cannot take: a `drive` on a pull request
  that has a ledger, an `answer` whose key is not a parked, unanswered
  question of that pull request, a second `hold`. The text of an `answer`
  is one line within a length limit, with no control characters and no
  hidden marker, since it reaches the drive's passes as a verdict.
- **`send` says who writes, and where.** Before it writes, it prints the
  repository in full, the login it writes as and the record. `--as <login>`
  refuses when the machine is signed in as someone else. An `answer` is a
  comment on the pull request, readable by whoever can read that pull
  request, and `send` says so. The comment carries the record envelope,
  which names the writer and its host.
- **`send` adds no authority.** Each reader keeps its own rule for whose
  record counts: an assignment made by a person with write access, a
  comment from a trusted author.
- **A person's commands are refused in a session the line started.** A
  dispatched launch and a drive's pass run with `JIG_LAUNCH` set to their
  launch record, and `send` refuses `assign`, `drive`, `hold`, `release`
  and `answer` when it is set. This stops a skill's mistake. It does not
  stop a session that sets out to act as its person: such a session can
  clear the variable or call the forge itself, as it can today, because it
  holds that person's credentials. `send` opens no new way to do that and
  closes none (see Left out).
- **A mailbox directive reaches a driver on this machine only.** For a
  drive that runs elsewhere, `send` refuses and names the host that holds
  it.
- **A verb whose record the repository has switched off is refused**, with
  the setting named: `drive`, `hold` and `release` need dispatch labels on.
  A machine can refuse every `send` (`send: false` in its dispatch file).
- **`--dry-run`** prints what a real send would, without writing. A real
  send ends with the link to what it wrote and the reader that acts on it:
  the dispatcher's next tick, or the drive's next round. The forge can take
  a moment to list a new comment, so that link, not an `ask` right after
  it, is the proof the request landed.
- **What can be taken back.** `release` undoes a `hold`; a `drive` label
  can be removed until the tick has armed the drive; `resume` withdraws a
  directive. An `answer` the re-arm has read cannot be taken back, which
  is why it is checked, shown and sent in the person's own words.

### The operator skill

`/jig:operator` is the skill a person talks to. It turns "where does 456
stand", "what is waiting on me" or "hold 456" into `jig ask` and `jig
send`, and answers in sentences. It holds no state: what it knows it has
just read, so any session on any machine can be the operator, and a session
that ends loses nothing. A person who wants one address's status without a
session runs `jig ask` and reads its plain answer.

- **"What is waiting on me"** is `jig ask --waiting --person <login>`, one
  read. The operator opens an address only to say more about one entry.
- **The status of a pull request** is `jig ask drive@<repository>#<PR>`,
  with whether it is ready to merge once item 36's predicate exists.
- **It sends a person's command only on that person's instruction in the
  same conversation.** It shows the `--dry-run` first, and for `answer` it
  sends the person's words, not its own summary of them.
- **What it reads is data.** Text in a thread never becomes a command: a
  send follows from what the person said, not from what a record says.

### What a launch hands on, and who a park waits on

These rules change records the line already writes, each in its own build
step.

- **A launch's result names what follows.** `jig dispatch result` gains
  the next owner: an address, a person, or `none` with a reason. Where the
  line fixes it, it is derived: a converged drive hands to `merge`, a
  finished follow-up to nobody. Where it does not, the session states it:
  a pick-up names the pull request it opened, or `none` and why (the item
  was a duplicate, the change was already made). The outcome row keeps it,
  and `ask` shows it as `last.next`.
- **A park names the person it waits on.** Each parked question carries
  one: the owner the change-area catalog gives the area the question is
  about, else the person the repository's dispatch section names
  (`dispatch.person`, optional), else the pull request's author. The
  notification names them, and `waitsOn` carries them. It routes the
  question and restricts nothing: an answer from any trusted author still
  counts.

### Where it lives

The address parser is `plugin/shared/address.ts`. `ask` and `send` are
components of the `jig` command (`plugin/ask/`, `plugin/send/`), registered
in `plugin/jig.ts` beside `dispatch` and `gc`. Both read and write records
through what their owners export (`plugin/shared/records/`, the
dispatcher's `lib/`, the drive's state modules). Where an owner has no read
narrow enough, such as one drive's verdict or one key's outcomes, the owner
gains it. The operator is `plugin/skills/operator/`.

## Build order

One pull request per step, each shippable alone. A step starts when the one
before it is in use and has shown the next is wanted.

1. **`jig ask`, with `--thread` and `--waiting`.** The parser, the
   stations, the answer, the thread and the list of what waits on a person,
   read-only; the outcome log's key column. An architecture decision record
   states the rule this design rests on: an address is derived from
   records, and a request is a record.
2. **`jig send`.** The verbs, their checks, `JIG_LAUNCH` set by the
   dispatcher's wrapper and the drive's pass launcher, `--dry-run`.
3. **The operator skill.**
4. **A launch's result names what follows.** The result's next owner, the
   outcome row and `last.next`.
5. **A park names the person it waits on.** The rule, the notification and
   `waitsOn`.

`merge` joins the stations, and `waitsOn` gains a converged pull request's
acts, in the pull request that builds item 36's predicate or in step 1,
whichever comes later.

## Left out

- **A resident agent per station.** A station is held while a launch runs
  and empty otherwise. An address that needed a live session to answer
  would need that session kept alive, compacted and replaced, which the
  records make unnecessary.
- **A queue or an inbox that a daemon holds.** `ask` and `send` run and
  exit, and what they read and write are the records of
  [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md). A request waits
  for its reader's next run, as a label does today.
- **Free text to a running session.** The dispatcher composes no prompt
  for a session, and `send` gives nobody a way to. A person who wants to
  talk to a session opens its workspace.
- **Telling a person from an agent signed in as them.** A session that
  holds a person's credentials can write what that person can, with `send`
  or without it. Closing that is the credentials' work: a session the line
  starts running as an identity the readers do not count as a person. It
  is not this design's.
- **Searching session transcripts, and waking a past session to answer.**
  Both read what no record holds, and a transcript can hold a secret.
  Either joins when `ask` is in use and a question it cannot answer from
  records has come up often enough to name, with its own flag, and no read
  escalates to it.
- **Addresses for standing roles**, such as the review arbiter or the agent
  a change area names. They leave no records keyed by a piece of work, and
  `do-item`'s routing already says which agent a change gets. A role joins
  when it leaves records an address can resolve from.
- **Stations a repository declares.** The list is the line's, so an address
  means the same in every repository.
- **A hold that ends by itself.** `hold` stays until a person releases it,
  as the label does today.
- **A mailbox directive to a driver on another machine.** The mailbox
  belongs to one working tree. Stopping a drive elsewhere stays that
  machine's act.
- **A file that declares the team.** Which agent, model and effort a piece
  of work gets is derived by rules
  ([ADR-0009](../docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md)),
  and who holds a station is read from records.

## Review

Critiqued by four reviewers with fresh context (subagents that did not
write it, as a critical chief technology officer, a security auditor, a
performance engineer and a cost optimizer) on 2026-11-05, against the draft
before its first commit. The report is in the pull request that added this
design.
