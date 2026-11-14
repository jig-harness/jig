# The Jig Protocol: design

**What problem this solves.** Jig's parts agree on shapes and closed lists:
a [drive](../GLOSSARY.md)'s end states and exit codes, the records Jig
writes, the labels and hidden comment markers it reads, the commands a
repository supplies. Programs outside Jig's skills read them too: the
dispatch dashboard's page, Jig's plugin for Orca, the planned
[hub](../GLOSSARY.md), a repository's own follow-up command, a second agent
harness. Each contract is defined once in code, as constants and typed
shapes, and restated by hand in several documents. Where a test ties a
restatement to the code, the copies agree; everywhere else they drift, and
a reader that learns a record's form from a document is led astray. No kind
of document can hold such a statement to the code today: a wrong
restatement is corrected only when someone notices it. With this built, each
contract has one chapter of the **[Jig Protocol](../GLOSSARY.md)**: its
values generated from the code, their meaning written beside them in the
code, and a gate that fails the build when the chapter and the code
disagree.

This is the design of [plan.md](plan.md) item 53. Its first build step is
in place: the generator, its gate and the chapter on the drive's end states
and exit codes, in [plugin/protocol/](../plugin/protocol/README.md); the
steps after it in § Build order are open. The decision that a chapter and the code must agree is
[ADR-0020](../docs/adr/ADR-0020-protocol-chapters-are-generated-and-gated.md).

## How it works

### What a contract is, and what is not one

A contract here is a value or a shape that one part of Jig writes and
another reads, where the reader may be a program outside Jig's skills: an
exit code a dispatcher branches on, a label a dashboard filters by, the
JSON of a record a hub stores. A function's signature inside one skill is
not a contract in this sense; nor is the wording of a message meant for a
person. A contract gets a chapter when it is closed (a fixed list of values,
or a shape with fixed fields) and some reader outside the part that writes
it depends on it.

Each value belongs to exactly one chapter. Where one source in code holds
values of several contracts (the records registry holds markers, claims and
the follow-up claim), each chapter names the entries it takes, and the gate
fails a value that two chapters take.

### Where the Protocol lives

The chapters live in `plugin/protocol/`, one Markdown file per chapter
(`plugin/protocol/<chapter>.md`), with an index page
(`plugin/protocol/README.md`) and the machine-readable files beside them
(`plugin/protocol/data/`, `plugin/protocol/schemas/`).

The reason is [ADR-0002](../docs/adr/ADR-0002-the-plugin-is-its-directory.md):
the plugin is its directory, and a machine that uses Jig has only that
directory installed. A skill that links to a chapter by a relative path
(`../../protocol/drive-exits.md` from a skill's folder) then reaches it on
every machine, the plugin cache included, and a program outside the skills
finds the data files and schemas at a known place in the installed plugin,
describing the release it runs. A top-level `protocol/` directory would read
more like a standalone specification, but every link from a skill to it
would break on a machine with the plugin alone, and a skill would have to
link to the website instead, which describes the latest release rather than
the installed one.

Living in `plugin/` costs a release per chapter change: a change to a
chapter is a change to the plugin, so it ships as a version with a change
note. Since a chapter changes only when its code does, that change note is
owed anyway. The generator does not ship: it runs in Jig's repository only
(below), so the plugin carries the chapters, never the means to regenerate
them.

### The chapter template

A chapter is made of:

- **A status line**, first under the title: the chapter's version, and
  `stable`, or `provisional` with the plan items that still move it, each
  linked to its epic issue, which a reader on an installed machine can open
  and which keeps its address if the plan renumbers the item. The status
  line is generated from the chapter list in the generator's source.
- **The prose**, written by hand: what the contract is for, who writes and
  who reads it, what a reader does with a value it does not know, and a
  link to the design or the skill that explains the mechanism.
- **The generated sections**, between a start and an end marker, each
  naming the source it is generated from. A generated section holds a
  table of every value with its meaning, and for a shape, its fields. The
  meaning of each value is written by hand, but in the code, as a required
  field of the table the code itself reads (a `meaning` string beside each
  entry), so a value added without a meaning is a type error, and the
  meaning moves with the value when the code changes. Where a source is a
  list with no room for a meaning (a union of strings, an unexported
  constant), the build step that writes its chapter first turns it into an
  exported table, as `terminal-states.ts` already is for the drive's exits.

Nothing inside the markers is edited by hand.

Filled in for one settled contract, the drive's end states and exit codes.
Its source is `TERMINAL_STATES` and `DRIVE_EXIT` in
`plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts`. The rows
below are a selection; the meanings are illustrative wording, and the
chapter's are those the table's `meaning` fields carry:

```markdown
# Drive end states and exit codes

Version 1 · stable

A drive reports how a round or the whole drive ended in two places. The
round script, `drive-status.ts`, exits with a code and, with `--json`, a
report whose `state` field names the state. The driver, `drive.ts`, exits
with a code and writes no report. The two scripts share one numbering but
not one meaning for every number: `drive-status.ts` exits `0` for
`ROUND_READY`, while `drive.ts` exits `0` for `CONVERGED`, so that a harness
reading a zero exit as success reads a converged drive as one. A dispatcher
reads `drive.ts`'s column; a program that runs a round itself reads
`drive-status.ts`'s.

Several states share a code. A `drive-status.ts` report tells them apart by
its `state`; a `drive.ts` exit is only its code, and states that share one
are not told apart. A reader that meets a code this chapter does not list
treats the drive as failed and does not re-arm it. A withdrawn code stays
listed as a tombstone.

How a drive reaches each state: [drive-pr's terminal states](../skills/drive-pr/references/terminal-states.md).

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts#TERMINAL_STATES,DRIVE_EXIT -->

| State | Kind | `drive-status.ts` exits | `drive.ts` exits | Ends the drive | Meaning |
| --- | --- | --- | --- | --- | --- |
| `ROUND_READY` | state | 0 | — | no | work exists for this round: run it |
| `CONVERGED` | state | 3 | 0 | yes | the head is merge-ready and certified |
| `HEAD_LAG` | state | 4 | 4 | no | the pull request's head has not caught up with the push |
| `NOT_SETTLED` | class-label | 4 | 4 | no | the class of states that wait for the pull request to settle; never itself a `state` |
| `RETIRED` | tombstone | 10 | — | — | withdrawn; the code is not given to another state |
| `SESSION_LEASE_HELD` | state | 11 | 11 | yes | another live session holds this round |
| `SINGLE_INSTANCE_LOCK` | driver-only | — | 11 | yes | another driver holds this clone's lock |

<!-- /protocol:generated -->
```

The kinds are the code's own categories (`state`, `class-label`,
`tombstone`, `driver-only`, and `helper` for an exit one of the drive's
helper scripts returns), rendered as the code names them. The chapter
covers every exit a drive script returns in this numbering, the helper
scripts' included (`PUSH_HELD`, exit `17`, which `guarded-push.ts` returns
and `skills/drive-pr/scripts/lib/state/mailbox.ts` reads from the table as
`PUSH_HELD_EXIT`), in a second section of its own, so that no code looks
free while it is in use.

### The chapters

| Chapter | Status | Source in code | Plan items that still move it |
| --- | --- | --- | --- |
| Drive end states and exit codes | stable | `TERMINAL_STATES`, `DRIVE_EXIT` and the exit sets beside them (`skills/drive-pr/scripts/lib/status/`), and the drive scripts' other exits | — |
| The drive mailbox: what a person or a tool may tell a running drive | stable | `skills/drive-pr/scripts/lib/state/mailbox.ts` and `mailbox-stop.ts` beside it | — |
| Pull-request labels Jig writes and reads | stable | `shared/pr-labels/` | — |
| Hidden comment markers on the forge and the tracker | stable | the forge and tracker kinds of `shared/records/registry.ts` except the claims below, `NOT_RECORDS`, and the marker codec in `shared/records/envelope.ts` | — |
| Commands a repository supplies | stable | `shared/repo-command.ts` and each caller's contract (the preflight's exit `3`, a facet store's JSON) | — |
| The follow-up claim and its result | stable | the `dispatch-followup` kind of the records registry and the follow-up outcomes (`dispatch/lib/followup-outcomes.ts`) | — |
| Addresses and the verbs of `jig ask` and `jig send` | provisional | `shared/address.ts` and `send/` | 39, 42 |
| Needs and structured answers | provisional | the decision record (`parked-decision/v1`) and the need classes | 46, 50 |
| Steward records | provisional | the steward's record kinds and their closed fields | 50 |
| Forge claims: takeover, launch and merge-ready | provisional | the `drive-takeover-claim`, `dispatch-launch-claim` and `drive-merge-ready` kinds of the records registry | 40, 49 |
| Tracker facets: type, priority and size | provisional | the facet stores and their answers | 41 |

Paths in the third column are written from the plugin directory. The
mailbox is stable as a drive's mailbox; making it every session's inbox, a
later idea in the plan, would only add to it.

A provisional chapter becomes stable in the pull request that finishes the
last plan item it names: that pull request removes the item from the plan
and from the chapter list, and the generator writes `stable`. The gate checks
the pairing both ways: a provisional chapter must name an item that is in
[plan.md](plan.md), and a stable chapter names none. Other contracts get a
chapter when a reader outside the part that writes them comes to depend on
them; a chapter is never written for a contract no such reader reads.

### What stable promises, and how the gate holds it

Each chapter carries its own version, an integer in the chapter list,
starting at 1. Within one version a stable chapter only grows: a value is
added; a value is withdrawn by keeping it listed as a tombstone, never by
deleting it, and never reused for another meaning; a field of a shape is
never removed or retyped, and no field becomes required or is newly
required: the accepted record shapes only widen. A change that breaks this
raises the chapter's
version, and its change note is marked breaking and says what a reader must
change ([changes/README.md](../changes/README.md) says which release that
asks for). The version is the chapter's own, not the plugin's: the plugin's
version moves for every change, and before its 1.0.0 a breaking change does
not move the major version at all.

A promise about what was there before cannot be checked from the code
alone, which only shows what is there now. So the check also reads the
chapter's data file (below) as the integration branch holds it, from the
merge base with that branch, and compares: a value or a field that the base
has and the new data file lacks, a value whose meaning changed to another
value's, a field whose type changed, or a field that is new and required or
that changed from optional to required or is new and identifies a value, a
listed value whose other published field changed (a withdrawal to a tombstone
excepted), fails the check unless the chapter's
version was raised. Which chapters are protected is read from the base too:
a chapter the base lists as stable stays stable. Marking it provisional,
or removing its entry or its files, fails the check unless its version was
raised and its change note is marked breaking: a note the branch adds or
changes holds a `**Breaking:**` entry that names the chapter's file. A
stable chapter is removed by listing it as withdrawn in the chapter list, at
a version above its last. When the merge base cannot be read (a shallow clone),
the check fails and names the fetch that fixes it, rather than passing
unchecked. A provisional chapter promises only that it states what the code
does in the release that ships it; the comparison applies to a chapter
the base holds as stable, whatever status the change gives it.

### The generator and its gate

The generator is `tools/protocol/generate.ts`, in Jig's repository, with its
tests in `tools/protocol/__tests__/`. It runs where the repository's
development dependencies are installed, never from the plugin cache.

- **What it reads.** The chapter list (`tools/protocol/chapters.ts`): for
  each chapter its file, version, status, the plan items that move it with
  their epic issues, and its generated sections, each a function that
  imports the code's own table (`TERMINAL_STATES`, `RECORD_KINDS`, …) and
  renders the entries the chapter takes. It imports the values, so a
  section shows exactly what the code holds.
- **What it writes.** Each chapter's status line and generated sections, in
  place between their markers, leaving the prose alone; the index page's
  list of chapters; `plugin/protocol/data/<chapter>.json`, the chapter's
  values as JSON; and each schema the chapter declares under
  `plugin/protocol/schemas/`.
- **The command.** `bun tools/protocol/generate.ts` regenerates every
  chapter; `bun tools/protocol/generate.ts --check` writes nothing and fails,
  naming each file and section that differs and the command that fixes it.
  It compares the data files and schemas as parsed JSON, not as text.
- **The inventory entry.** A `generated:` entry of a new `protocol` area in
  the change-area catalog (`.config/change-areas.yaml`), whose `paths` are
  `plugin/protocol/**` and `tools/protocol/**`: the generated-file inventory
  [CONTRIBUTING.md § Derived files](../CONTRIBUTING.md#derived-files)
  describes. Its outputs are the chapters, the index page, the data files and the
schemas;
  its `notes` say that a chapter's prose outside the markers is written by
  hand and only the marked sections and the status line are derived, and
  that the JSON files carry no generated header, so the entry is their
  marker. Its command and check are the two above. `bun run gates` runs the
  check through M2's runner with every other entry.
- **Its sources are checked, not listed by hand.** The entry's `source`
  names `tools/protocol/**` and each file a chapter imports from. The
  generator's tests record every module a chapter's sections import and
  fail when the entry's `source` misses one. They also enumerate each
  eligible entry of the imported tables on their own and fail when a chapter
  neither renders it nor lists it as an explicit exclusion, in both
  directions
  ([M2 § Generators reach every input](../modules/M2-generated-artifact-freshness/README.md#generators-reach-every-input)).
- **The commit-time twin.** M2's triad needs a step that regenerates and
  stages the chapters at commit time. The repository's pre-commit hook
  (`lefthook.yml`) runs `bun tools/protocol/generate.ts --stage` when a
  staged file is among the entry's sources, and stages each chapter it
  changed.

Besides comparing the output and the base, the check refuses: a chapter
file with no entry in the chapter list, or an entry with no file; a marker
whose source is not the one the list names; a table entry whose `meaning` is
empty; a value two chapters take; a provisional chapter whose plan item is
not in [plan.md](plan.md), and a stable one that names an item.

The ladder of [M2](../modules/M2-generated-artifact-freshness/README.md#the-decision-ladder-drop--check--commit)
prefers not committing a derived file. The chapters are committed because
they are read at rest by readers with no generator: an installed plugin, a
skill's link, the website's build and a program outside Jig. Two branches
that change the same contract conflict in the chapter as they already
conflict in the code; the conflict is resolved by regenerating, never by
editing the generated section.

### Machine-readable files for readers outside the skills

Every chapter ships its values as JSON in `plugin/protocol/data/<chapter>.json`,
generated with the chapter: a program in any language loads the closed list
without parsing Markdown. Each file carries the chapter's version, its
status and, for a provisional chapter, its plan items, and declares each
field of its values: its type, whether it may be null, whether every value
carries it, and whether it is part of what makes a value the same value
from one version to the next. It is also the baseline the check compares a
stable chapter against: a value is matched by those identifying fields, so
a renumbered value reads as one removed.

A contract that a reader outside the skills parses as a JSON document also
gets a JSON Schema (draft 2020-12) in `plugin/protocol/schemas/`:

| Contract | Schema |
| --- | --- |
| The drive mailbox | a message a person or a tool writes to a running drive |
| Hidden comment markers | the record envelope, and each marker's payload |
| The follow-up claim and its result | the claim and the result record |
| Needs and structured answers (provisional) | the decision record a pass writes, and an answer |
| Steward records (provisional) | each record kind |
| Forge claims (provisional) | each claim |
| The commands a repository supplies and tracker facets | the JSON a facet store answers with, and the output shapes callers parse |

Exit codes and labels are lists of words or numbers, read one value at a
time, and get the data file alone; the lists of commands and facets do too,
and only the JSON their callers parse gets a schema. Addresses are strings with a grammar; their chapter states the
grammar and its data file lists the stations and verbs, without a schema.

**How a schema is held to the code.** A schema is not derived from a
TypeScript type: turning a type into a schema needs the compiler's type
checker, and the TypeScript interface the repository's checks use today
parses syntax only. Instead, a shape that gets a schema is declared once in code as data:
a description of its fields from which the code's TypeScript type is
inferred and against which the code's reader validates what it reads. The
generator writes the schema from that same description. The step that
writes a contract's schema first moves its reader onto such a description,
where it is not on one already. Then the generator's tests encode a record
through the writer's own exported function (the envelope codec's `encode`,
each marker's writer) from the inputs the writer's tests use, and validate
the result against the schema, so a record the code writes that its schema
refuses fails the gate. A schema's `$id` names its chapter and the chapter's
version.

### Which document wins

The Protocol is a kind of document of its own
([docs/README.md](../docs/README.md#kinds-of-document)), and it ranks after
terms and before reference: decisions; instructions; terms; the Protocol;
reference; doctrine; plans; history. A reference document that restates a
contract differently from its chapter is corrected to the chapter, or made
a link to it.

A chapter's generated sections cannot disagree with the code on the
integration branch: the gate fails the build first. On a branch, a change
to the code that the chapter no longer matches is settled one way only, by
regenerating the chapter. When the regenerated chapter breaks a stable
chapter's promise without raising its version, the check fails: the code is
changed back, or the version is raised and the change note marked breaking.
The chapter's prose is held by review, as a reference document is: when it
describes behaviour the code does not have, the code settles what Jig does
today and the prose is corrected. The promise that binds the code is the
stability rule above, which [ADR-0020](../docs/adr/ADR-0020-protocol-chapters-are-generated-and-gated.md)
decides and the gate checks; the prose binds nothing the gate does not.

### Restatements become links

Today each contract is restated in several documents. Each restatement ends
one of two ways: it becomes a link to its chapter, or it stays as a **held
restatement**, a copy the chapter's gate checks against the code, as the
drive's exit-code consistency check
(`plugin/skills/drive-pr/__tests__/terminal-states-consistency.test.ts`)
checks its restatements today. A restatement stays only where an agent
acts on the value at that step and a link would cost it a read in the
middle of a procedure: a `SKILL.md` step that branches on an exit code. Every
other restatement becomes a link.

For each contract, once its chapter exists, the documents change in this
order:

1. **The documents programs outside the skills are pointed to**:
   [plugin/RECORDS.md](../plugin/RECORDS.md) (where the drift found so far
   was), the configuration reference's sections on labels and markers, and
   the pages for the dashboard and the Orca plugin. These become links
   first, because their readers have no skill to correct them.
2. **The skills' references** (`references/*.md`): each table that restates
   a contract becomes a link with one sentence on why the step needs it.
3. **The `SKILL.md` files**: a restatement whose step acts on the value
   becomes a held restatement, checked by the chapter's gate; the rest
   become links.

The skills follow the contracts they restate, in the build order: `drive-pr`
first (exit codes, mailbox, labels), then the dispatcher's documents and
`operator` (exit codes and labels as the dispatcher reads them), then
`do-item` and `work-batch` (comment markers, the commands a repository
supplies), then `followup` (the follow-up claim), then `steward` and the
skills that read the provisional chapters, each as its chapter lands.

An existing consistency check folds into the chapter's gate only in the
pull request that shows the gate fails on each case the old check failed
on. The drive's exit-code check folds into the exit-code chapter's gate. The
operator skill's test (`plugin/skills/operator/__tests__/skill.test.ts`)
checks addresses and the verbs of `jig send`, which belong to the
provisional Addresses chapter; its restatements of the verbs fold in with
that chapter, and its checks that a command parses stay a test, since a
chapter holds values, not behaviour.

### How the site renders the chapters

The website builds its pages from the repository's documents
([design/website.md § One source](website.md#one-source-the-repositorys-documents)).
Each chapter renders as one page: the status line as a badge (stable, or
provisional with links to its plan items on the roadmap), the prose, and the
generated tables, with an anchor per value so a page can link to one exit
code or one label. The index page renders as the Protocol's landing page.
The data files and schemas are published as they are, at addresses that
keep the chapter's name and version. The route and the page table's row are
the message design's to place
([#1018](https://github.com/jig-harness/jig/issues/1018)), which owns
`design/website.md`; this design hands them to it.

## Build order

Each step is one pull request, shippable alone.

1. **The generator, the gate and the first chapter.** `tools/protocol/`, the
   chapter list, the `protocol` area and its inventory entry, the commit-time
   twin in `lefthook.yml`, the base comparison, the index page, and the
   chapter on the drive's end states and exit codes, with `meaning` added to
   `TERMINAL_STATES` and the drive's other exits moved into it. Its data file
   ships with it.
2. **The records chapters**: hidden comment markers, and the follow-up claim
   and its result, both generated from the records registry, with a
   required `meaning` added to every kind the registry holds.
3. **The drive mailbox and the pull-request labels.**
4. **The commands a repository supplies.**
5. **Schemas for the stable chapters**: the shape descriptions and the
   generator's schema step with its round-trip tests, then the schemas the
   table above names for the mailbox, the markers, the follow-up claim and
   the output shapes callers parse from the commands a repository supplies,
   each reader moved onto its description in the same pull request. The
   tracker-facet schemas belong to the provisional chapter's step.
6. **The stable chapters' restatements become links**, in the order above,
   with the drive's exit-code check folded into its chapter's gate.
7. **The provisional chapters**, one pull request each, with their data
   files and schemas, as each one's code settles enough that a reader outside
   the skills reads it. The Addresses chapter exports the list of stations
   from `shared/address.ts` and folds in the operator test's restatements of
   the verbs.
8. **The site's pages**, once the message design has placed their route.

## Left out

- **A specification written by hand.** It would be one more restatement to
  drift.
- **The word "spec".** It means the spec a work item links
  ([spec-link.md](spec-link.md)); the Protocol uses "chapter".
- **Generating code from the chapters.** Derivation runs one way, from the
  code to the chapter. A reader in another language may generate its own
  types from the schemas; Jig does not.
- **Chapters for contracts no outside reader reads.** A shape inside one
  skill stays documented with that skill.
- **The site's route and the page table's row.** The message design places
  them.
- **What a dispatched session leaves behind**
  ([#1017](https://github.com/jig-harness/jig/issues/1017)). A later
  provisional chapter may cover its closing report once that design defines
  it.

## Review

Reviewed on 2026-11-13 by a reviewer with fresh context (a subagent that did
not write it), against the design as first drafted on top of commit
`d268b8205`, before the first build step. The design states the result.
