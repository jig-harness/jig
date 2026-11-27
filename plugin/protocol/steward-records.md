# Steward records

Version 1 · provisional, moved by [plan item 50](https://github.com/jig-harness/jig/issues/940)

The [steward](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is
an agent pass a [dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)'s
host starts when a repository holds stopped or waiting work that no rule of
the line settles. It reads a digest of that work, including logs, handoffs
and tracker text that anyone could have written, so it is never allowed to
act on what it finds. It writes
[steward records](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
instead, from a closed list, and the dispatcher's next
[tick](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) checks each
one against what the tick reads itself and applies it under its own guards.
Without a closed list, an instruction planted in a log could ask the tick for
anything; with one, it can ask only for what the tick would do anyway on the
same facts.

This chapter lists those records: each kind and what the tick does with it,
the fields of each kind, the causes a run's record may name, and the bounds a
submission is held to. The steward's skill writes them, the tick reads and
applies them, and the dispatch dashboard shows the needs they framed. A
program that submits records for a steward pass, or reads the ones a host
keeps, reads them here. How the steward decides what to propose:
[the steward skill](../skills/steward/README.md).

## How records are submitted and read

A pass submits once, through the steward skill's script,
`steward.ts submit <launch-id> <token> --input <file>`, the file holding a
JSON list of records. The launch token the dispatcher gave the pass
authorizes that one submission; an empty list is a submission too. The
records stay in the owner host's state database (`steward_records` in
`state.sqlite`), never on the forge or the tracker.

The reader checks the whole list before it keeps any record, and refuses all
of it at the first record that does not read, for a reason: the
submission is not a list within the `records` bound below; a record has no
reason; its kind is not listed below, or it carries a field its kind does not
have; or a field does not hold a value its kind allows. Every field of a kind
is required, and a string is never empty or only white space.

The tick reads each kept record through the same reader before it applies
it. Applying one is the tick's alone. It applies only a record whose targets
are in the pass's own digest, and checks again the facts each kind's meaning
below names. It claims a re-arm, a resume, a facet or a cause before it acts
on it, so none is applied twice; a need's framing and a queue order hold for
as long as their need or their tie does. A record whose facts no longer hold
is refused for good, except a resume refused for a fact that can change (the
autonomy policy, a pass the steward named wrongly), whose pass the next
digest offers again.

A record's closed values shared with another contract are that contract's:
a need's act is one of the acts a need names (`NEED_ACTS` in
`plugin/shared/acts.ts`), and a facet record's facet and priority are those
of [the tracker facets chapter](tracker-facets.md).

## What a reader does with a record it does not know

A reader never applies a record of a kind this chapter does not list, a
record with a field it does not list, or a value outside a closed list: it
refuses the record, and a submission that holds one. The tick skips a kept
record that no longer reads. The record kinds a host is planned to opt into,
`settle`, `redrive` and `rerun-checks`, are not built and not listed here;
until they are, the reader refuses them like any other kind it does not know.

## The records

The registry's kind the host keeps the submitted records as:

<!-- protocol:generated source=plugin/shared/records/registry.ts#RECORD_KINDS -->

| Kind | Medium | Markers | Version | Key | Meaning |
| --- | --- | --- | --- | --- | --- |
| `dispatch-steward-record` | machine |  | 53 | — | The closed records a steward pass submitted. The next tick claims each before acting on it, and first checks again the stops, holds and budgets that apply. |

<!-- /protocol:generated -->

## The record kinds

<!-- protocol:generated source=plugin/dispatch/lib/steward-record-values.ts#STEWARD_RECORD_KINDS -->

| Kind | Meaning |
| --- | --- |
| `rearm` | Re-arm a stopped drive once, its handoff and logs showing a passing cause. The tick re-arms it only while the drive's facts read as the record's, no person stopped or held it, no registry-class park waits on it, the recovery budget is not spent and no earlier record re-armed the same facts; otherwise it refuses the record. |
| `resume` | Resume an ended pickup or follow-up pass that stopped on a question outside the repository's human-decision classes and recommended one option. The tick launches it again with one fixed instruction, to take the option it recommended and record it as a decision taken unattended, after checking the account, holds and recovery budget again; no free text reaches the session. |
| `need` | Frame a need that arrived with no framing and stays a person's: the act it asks for and a one-sentence ask. The tick shows them on the need while its cause and question are unchanged; a need that arrived framed is never framed again, and a record for one is refused. |
| `facet` | Fill a missing priority, type or size of an assigned issue in the queue. The tick posts the proposal and its reason on the issue, reads the issue again, and writes the value only while the facet is still empty and the issue still assigned as the digest read it. |
| `order` | Order issues of the queue its own rules leave tied (priority, unblocking, epic order, size and age). The tick exchanges only the places of the members that are still tied, and never moves an issue past one the rules rank apart. |
| `cause` | Say why a pickup's or a follow-up's run that ended without a closing report fell short, read from the excerpt of its transcript. The tick records it as the run's closing report, written by the steward, only while the run holds none; otherwise it refuses the record. |

<!-- /protocol:generated -->

## The records' fields

Every record carries `kind` and `reason`, and its kind's own fields beside
them, every one required, and no other.

<!-- protocol:generated source=plugin/dispatch/lib/steward-record-values.ts#STEWARD_COMMON_FIELDS,STEWARD_RECORD_KINDS -->

| Kind | Field | Type | Meaning |
| --- | --- | --- | --- |
| every kind | `kind` | string | Which of the record kinds it is. A record of a kind not listed, or with a field its kind does not have, is refused with the whole submission. |
| every kind | `reason` | string | Why the steward proposes the record, in its own words. The tick carries it as the reason of what it does: beside a framed need's ask, on a facet's proposal comment, on a re-arm's receipt. It is text a pass wrote after reading untrusted evidence, so a program never acts on it. |
| `rearm` | `target` | string | The stopped drive's pull request, as `PR #<number>`: one of the drives in the pass's digest. |
| `rearm` | `facts` | string | The drive's facts as the digest gives them (`evidence.stewardFacts`), copied exactly: the tick compares them with the drive's facts when it applies the record. |
| `rearm` | `class` | string | The recurring cause the steward read, in its own words. Three applied re-arms of one class in a repository within a week propose a reflection finding for a rule that settles it without judgment. |
| `resume` | `record` | string | The launch record of the ended pass: one of the passes in the digest. |
| `need` | `target` | string | The need's target, as the digest's `needs` name it: only a need with no framing may be named. |
| `need` | `act` | string | What the person is asked to do: one of the closed acts a need names (`NEED_ACTS` in `plugin/shared/acts.ts`). A registry-class park keeps its own act. |
| `need` | `ask` | string | One sentence asking the person for the act. |
| `facet` | `target` | string | The issue's key: an assigned issue in the digest's queue. |
| `facet` | `facet` | string | Which facet is missing: `priority`, `type` or `size`, the issue facets of the tracker facets chapter. |
| `facet` | `value` | integer or string | The value proposed: for a priority, its number from 1 (urgent) to 4 (low); for a type or a size, a canonical value of the repository's label taxonomy and facet configuration, which the tracker checks in the facet's configured store. |
| `order` | `targets` | string[] | The tied issues' keys in the order proposed, each in the digest's queue and none twice. |
| `cause` | `record` | string | The launch record of the run: one of the runs the digest lists as ended without a report (`unreported`). |
| `cause` | `cause` | string | Why the run fell short: one of the causes listed below. |
| `cause` | `summary` | string | What the run had done and where it stopped, with no secret, personal data or quoted output; it becomes the closing report's `concluded`. |

<!-- /protocol:generated -->

## The causes a run's record names

<!-- protocol:generated source=plugin/dispatch/lib/steward-record-values.ts#STEWARD_CAUSE_VALUES -->

| Cause | Meaning |
| --- | --- |
| `needs-person` | The run reached something only a person can decide or do, and stopped there. |
| `refused` | The run declined the work, or was refused a step it needed by a rule, a permission or a policy. |
| `tool-failed` | A tool the run depended on (a command, a script, a service) failed, and the run could not go on. |
| `environment` | The host or the checkout kept the run from working: a missing dependency or credential, a broken tree, a full disk. |
| `scope` | The work was larger than, or other than, what the item described, and the run stopped rather than widen it. |
| `crashed` | The transcript stops mid-work with no error that explains it. |
| `unknown` | The excerpt does not show why the run fell short, or there is no excerpt. |

<!-- /protocol:generated -->

## The bounds

<!-- protocol:generated source=plugin/dispatch/lib/steward-record-values.ts#STEWARD_RECORD_LIMITS -->

| Bound | Value | Meaning |
| --- | --- | --- |
| `records` | 100 | The most records one submission holds. |
| `targets` | 100 | The most issue keys one `order` record names. |
| `text` | 4000 | The longest string a record carries, in UTF-16 code units: its reason, and each field other than the bounds below. |
| `facet-value` | 100 | The longest type or size a `facet` record proposes, in UTF-16 code units. |
| `summary` | 600 | The longest summary a `cause` record carries, in characters: the closing report's bound on what a run concluded. |

<!-- /protocol:generated -->

## JSON Schemas

Each record kind has a schema generated from the description its reader
validates against: [`rearm`](schemas/steward-rearm.json),
[`resume`](schemas/steward-resume.json), [`need`](schemas/steward-need.json),
[`facet`](schemas/steward-facet.json), [`order`](schemas/steward-order.json)
and [`cause`](schemas/steward-cause.json); and a submission, the list of
records a pass submits, has [its own](schemas/steward-submission.json). What
a schema cannot say, the tick still checks: that a record's target is in the
pass's own digest.

A string's bound in UTF-16 code units is written as a pattern. Jig's reader
reads the pattern without Unicode mode, so it counts code units, and accepts a
string with an unpaired surrogate; a validator that reads it in Unicode mode
counts characters, and accepts a string of characters outside the Basic
Multilingual Plane, such as emoji, that Jig's reader refuses at the bound.

The records' kinds, fields, causes and bounds, for a program in any
language: [data/steward-records.json](data/steward-records.json).
