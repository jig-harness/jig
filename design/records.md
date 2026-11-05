# Records: one envelope, one registry, records shared across hosts: design

**What problem this solves.** Jig's execution line runs as programs that
never share a process: the dispatcher's tick, a drive's loop control and
its passes, a pickup's session, a follow-up, `jig gc`. They coordinate
through the records each leaves behind, and there are many: a drive's state
directory on the machine with its locks, leases and claims; its mailbox and
handoff file in the working tree; its ledger and takeover claims on the
pull request; the dispatcher's database, receipts, walls and outcome log;
the follow-up marker; reply markers, the deferred section of a pull
request's body, tracker claims. Each family grew its own envelope, its own
idea of who wrote it and its own versioning; the drive's state file carries
no version at all. Nothing lists them in one place, and nothing notices a
new marker or state file that no reader knows. A host sees only its own
machine records, so a second host cannot tell who holds a launch or whether
a follow-up ended. With this built, every record says what it is, its key,
who wrote it and when, in the same fields; a registry lists every kind and
a gate checks named markers, tagged drive state families and tables; review
keeps other records in the inventory. The machine records sit in one database
per component with migrations a reader can check; and what a second host needs
travels on the forge, through one interface.

This is the design of [plan.md](plan.md) item 37. Its first step is built:
the envelope and its codec (`plugin/shared/records/envelope.ts`), the
registry (`plugin/shared/records/registry.ts`), the gate that checks those
forms (`scripts/check-records-registry.ts`), the drive ledger
and the follow-up marker carrying the envelope, and the view by record,
[plugin/RECORDS.md](../plugin/RECORDS.md). So is its fourth: the
forge-claims module (`plugin/shared/records/forge-claims.ts`). Why there is
no daemon or bus is
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md).

## How it works

### The envelope and the registry

Every record carries an envelope: `kind` (its registered name), `v` (its
kind's schema version, an integer), `key` (what it is about, unique within
its kind), `writer` (the login where known, the host, the boot id, the
process id and its start time; the host and boot id as digests on the forge
and tracker), `at` (when it was written) and, for a record rewritten in place,
`generation`. The envelope's fields sit beside the payload's at the top
level of one JSON object, so a reader written before the envelope still
reads the record. One codec writes it as a file's JSON and puts the same
bytes inside a hidden HTML-comment marker on the forge, with `<` and `>`
escaped. Readers return an `Outcome`
([ADR-0012](../docs/adr/ADR-0012-failures-as-values.md)) and never throw on
what they read; the envelope passes a strict form (the kind is registered,
the version is an integer no newer than the reader's, the key has the
kind's shape), and the payload is data that no reader acts on.

The registry lists every kind: its medium (`machine`, `tree`, `forge`,
`tracker`), its owner, its file pattern, table or hidden marker, and its
current schema version. A kind another tool writes and Jig only reads is
registered as foreign. The gate derives what the code names (every
hidden-marker literal, every family a drive state-file pattern is tagged
with, every SQLite table) and fails on one the registry does not hold, and
on a registry entry the code no longer names.

Records adopt the envelope one family at a time, each keeping its earlier
form readable for one release. The drive ledger's data and the follow-up
marker come first. A kind another design adds registers when it is built:
the dispatch board's `board_seen` table and its "became ready" and "left
ready" rows, which are rows of the outcome log, not kinds of their own.

### One identity and lease module

The process identity a launch claim records (`plugin/dispatch/lib/launches.ts`),
the one a drive's lease and lock record (`plugin/skills/drive-pr/scripts/lib/state/lease*.ts`,
`plugin/skills/drive-pr/scripts/lib/claim.ts`) and the one a worktree hook reads
(`plugin/shared/worktree-hooks.ts`), with the record writer's
(`plugin/shared/records/writer.ts`), become one module, `plugin/shared/liveness.ts`:
who holds something (host, boot, process and its start time), and whether
that holder is alive here, dead here, or unknown because it is on another
host or the process table cannot be read. Every lease, lock and claim asks
it the same question and gets the same three answers.

### The machine's records in SQLite

The drive's state directory moves into SQLite through a shared
`plugin/shared/records/db.ts`, which the dispatcher's database
(`plugin/dispatch/lib/state.ts`) also opens through: additive migrations only, a
schema version, and a minimum-reader version, so an older plugin refuses a
database a newer one changed incompatibly and reads one that only gained
columns or tables. There is one database per component (the drive's, the
dispatcher's, collection's), never one shared by all, so a component's
migration never waits on another's. A record the working tree holds stays
a file there: the mailbox, which any sender appends to, and the handoff
file, which a person reads.

### One forge-claims module

A claim on the forge is a comment that says "this is mine to do": the
takeover claim, the follow-up marker and the merge-ready announcement. One
module, `plugin/shared/records/forge-claims.ts`, posts, reads back and
decides all three. A claim comment opens with its kind's line, holds the
envelope in the codec's marker form, its `key` what is claimed
(`takeover:<generation>`, `followup`, `merge-ready:<head>`), and ends with
text a person reads. One rule decides: for each key and generation, the
earliest comment from a trusted author wins (`plugin/shared/trusted-authors.ts`
names who is trusted, for every claim). The takeover's rule adds the lease
window as a lapse window, past which a later claim replaces a winner whose
owner never wrote the ledger. The forge has no conditional create for a
comment and its listing can lag, so `post` reads the claims back, reads
again a bounded number of times while the listing does not show the
caller's comment, and then reports the claim lost rather than counting a
comment it never saw; `check` re-reads it before each act outside the pull
request, and `withdraw` deletes the caller's own. The residue it cannot
close, two read-backs that each lag past the other's comment, is named in
the module's header with what each kind's callers do once a read lists
both.

Each kind keeps its comment form and still reads the form written before
it for one release: the takeover claim and the announcement gained the
envelope, and the follow-up marker's key became `followup` in its version
2, its earlier versions read through the kind's own reader. The
announcement became a claim per pull request and head, so a second driver
cannot announce over an earlier trusted announcement of the same head, and
it is posted only inside its claim: behind its merge-readiness check, read
back, and withdrawn through the module. The drive ledger, rewritten in
place rather than claimed, still picks its canonical comment in its own
reader by the same lowest-trusted-id rule, and the deferred entries in a
pull request's body keep their reread-and-retry write.

### Records a second host reads

A `SharedRecords` interface says what a host publishes for another to read,
forge-backed first: who holds a launch (its record, its claim and its
host's digest), and whether a follow-up ended and how. A second host then
sees who holds a pull request's launch before it starts its own, and does
not start a follow-up another host finished. One host owns each
repository's board, notifications and history rows, so two hosts never
notify a person twice or write the same outcome twice. A second
implementation, a small control-plane service, joins behind the same
interface when [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)'s
conditions for reopening hold.

### The dispatcher reads the drive's own records

The dispatcher reads a drive's exit codes from drive-pr's terminal-state
registry (`plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts`) instead
of naming them itself. A drive, its ledger and the dispatcher's thread
samples count rounds from one definition. A mailbox directive is addressed
to a driver generation, so a directive sent to one driver is never obeyed
by its successor.

## Build order

One pull request each, in this order; each is usable on its own.

1. **The envelope and the registry** (built): the envelope and its codec,
   the registry of every kind that exists, the gate, the ledger's data and
   the follow-up marker carrying the envelope with their earlier forms
   still readable, [plugin/RECORDS.md](../plugin/RECORDS.md) and
   [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md).
2. **One identity and lease module**: `plugin/shared/liveness.ts`, with the
   launch claim, the drive's leases and locks and the worktree hooks moved
   onto it.
3. **The machine's records in SQLite**: `plugin/shared/records/db.ts`, the
   dispatcher's database opened through it, then the drive's state
   directory moved into its own database, its files still read for one
   release.
4. **One forge-claims module** (built): `plugin/shared/records/forge-claims.ts`,
   with the takeover claim, the follow-up marker and the merge-ready
   announcement as its claims, decided by its one rule and each kind's
   earlier form still readable.
5. **Records a second host reads**: `SharedRecords` on the forge, the
   launch and the follow-up's end published, and one owner host per
   repository for the board, notifications and history rows.
6. **The dispatcher reads the drive's own records**: exit codes from the
   terminal-state registry, one round counter, mailbox directives
   addressed to a driver generation.

## Left out

- **A daemon or a message bus.** Every message must outlive its sender, and
  a bus across hosts needs an inbound route; see
  [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md), which also says
  when to reopen it.
- **An event log as the source of truth.** The dispatcher derives what is
  wanted from records it does not own and keeps only what it did; a log of
  its own events cannot say what is wanted.
- **A mode switch between a centralised and a workspace-by-workspace
  setup.** The medium is derived, never configured: the machine's store is
  SQLite whether or not a dispatcher runs, and a session without one reads
  and writes the same records.
- **The mailbox as every session's inbox.** It stays a drive's, until a
  second kind of nudge exists that needs it.
