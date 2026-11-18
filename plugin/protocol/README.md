# The Jig Protocol

Jig's parts agree on a few closed lists and shapes: the way a drive reports
how it ended, the records Jig writes, the labels and hidden comment markers
it reads, the commands a repository supplies. Programs outside Jig's skills
read them too: a dashboard, a workspace app, a repository's own scripts,
another agent harness. The
[Jig Protocol](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is
the one statement of each such contract, one chapter per contract, written
for a reader that acts on the values without reading Jig's code.

You can trust a chapter because it is not written by hand where it matters.
Its values, and the meaning of each, are generated from the tables Jig's own
code reads, and Jig's build fails when a chapter and the code disagree. Only
the explanation around them is prose. Each chapter carries its own version
and says whether it is:

- **stable**: within one version it only grows. A value is never removed or
  given another meaning (a withdrawn value stays listed as a tombstone), and
  a field is never removed, retyped or made required. A change that breaks
  this raises the chapter's version, and the release notes say what a reader
  must change.
- **provisional**: it states what the code does in the release that ships
  it, and names the plan items that may still change it.

Each chapter's values are also in a JSON file under [data/](data/), with the
chapter's version, status and a description of each field, for a program in
any language. These files describe the plugin release they ship in.

A field's `comparedAs` says what a stable chapter promises about its content
within one version. An `exact` field does not change. A `prose` field may be
reworded, but is not emptied or newly stated on a value. A `names` field, a
comma-separated list, may gain a name and never loses one, in any order. A
`carriers` field lists what carries a value, each with `always` or
`sometimes`: what always carried it still does, and anything else joins or
leaves only as `sometimes`.

JSON documents also have draft 2020-12 JSON Schemas in [schemas/](schemas/).
Their `$id` identifies the owning chapter and its version. The descriptions
that generate them also supply the readers' field checks and TypeScript
types. Tests validate records from the writers with an independent schema
validator. Marker lines that carry text rather than JSON have no schema.

These schemas describe structural acceptance. Calendar-time validity,
relationships between fields (such as a record's pull-request number and
its envelope key), repository-specific names and author trust are checked
by the readers too. Optional telemetry that a reader ignores or normalizes
when unusable remains permissive in its schema. Passing a schema never
authorizes an action.

## Chapters

<!-- protocol:generated source=tools/protocol/chapters.ts#CHAPTERS -->

| Chapter | What it covers | Version | Status | Data file |
| --- | --- | --- | --- | --- |
| [Drive end states and exit codes](drive-exits.md) | How a drive, or one round of it, ended: each state and the exit code `drive-status.ts` and `drive.ts` report it with. | 1 | stable | [data/drive-exits.json](data/drive-exits.json) |
| [The drive mailbox](mailbox.md) | What a person or a tool may tell a running drive, and how the drive answers: the messages, directives and acknowledgements in a working tree's mailbox files. | 1 | stable | [data/mailbox.json](data/mailbox.json) |
| [Pull-request labels Jig writes and reads](pr-labels.md) | The labels that show where a pull request's drive or follow-up stands, and the labels a person adds to tell the dispatcher what to do with it. | 1 | stable | [data/pr-labels.json](data/pr-labels.json) |
| [Hidden comment markers on the forge and the tracker](comment-markers.md) | The hidden markers Jig writes and reads in comments and bodies on the forge and the tracker: what record each marks, who writes it, its version and what it means. | 1 | stable | [data/comment-markers.json](data/comment-markers.json) |
| [Commands a repository supplies](repo-commands.md) | The settings whose value is a command Jig runs: what each command is given, what it answers with, its deadline and the exits its caller reads. | 1 | stable | [data/repo-commands.json](data/repo-commands.json) |
| [The follow-up claim and its result](followup-claim.md) | The marker that claims a merged pull request's follow-up: who took it, a dispatcher's tick or a person's run, and how it ended. | 1 | stable | [data/followup-claim.json](data/followup-claim.json) |
| [Rule matchers in configuration](rule-matchers.md) | The configuration fields that select by an item's or a change's facts: the facts a rule may test, how each is compared, how a rule combines its values, and how a field's rules resolve. | 1 | stable | [data/rule-matchers.json](data/rule-matchers.json) |
| [Addresses and the verbs of `jig send`](addresses.md) | The stations an address names on a piece of work, what each one's key is, and the verbs `jig send` tells a station. | 1 | provisional, moved by [plan item 39](https://github.com/jig-harness/jig/issues/485), [plan item 42](https://github.com/jig-harness/jig/issues/541) | [data/addresses.json](data/addresses.json) |
| [Forge claims: takeover, launch and merge-ready](forge-claims.md) | The claims a driver and a dispatcher post on a pull request: a driver's takeover of another clone's drive, a dispatching host's launch of a drive, and a driver's announcement that a head is safe to merge. | 1 | provisional, moved by [plan item 40](https://github.com/jig-harness/jig/issues/517), [plan item 49](https://github.com/jig-harness/jig/issues/865) | [data/forge-claims.json](data/forge-claims.json) |
| [Tracker facets: type, priority and size](tracker-facets.md) | The facts every issue carries beside its labels, the numbers of the priorities, the stores a facet may be kept in and which each tracker adapter holds, and why a facet's store is the one in force. | 1 | provisional, moved by [plan item 41](https://github.com/jig-harness/jig/issues/518) | [data/tracker-facets.json](data/tracker-facets.json) |
| [Needs and structured answers](needs-and-answers.md) | A decision waiting for a person and the answers to it: the decision record's fields, the forms and lines of a structured answer and how it is normalized, the acts a need asks for, and the dispatcher's own framings with the options it carries out. | 1 | provisional, moved by [plan item 46](https://github.com/jig-harness/jig/issues/693), [plan item 50](https://github.com/jig-harness/jig/issues/940) | [data/needs-and-answers.json](data/needs-and-answers.json) |
| [Steward records](steward-records.md) | The closed records a steward pass submits for the dispatcher's next tick to check and apply: each kind, its fields, the causes a run's record may name and the bounds of a submission. | 1 | provisional, moved by [plan item 50](https://github.com/jig-harness/jig/issues/940) | [data/steward-records.json](data/steward-records.json) |

<!-- /protocol:generated -->

How the chapters are generated and checked:
[design/protocol.md](https://github.com/jig-harness/jig/blob/main/design/protocol.md),
and the decision behind it:
[ADR-0020](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0020-protocol-chapters-are-generated-and-gated.md).
