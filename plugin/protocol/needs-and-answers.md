# Needs and structured answers

Version 1 · provisional, moved by [plan item 46](https://github.com/jig-harness/jig/issues/693), [plan item 50](https://github.com/jig-harness/jig/issues/940)

Some of the work on Jig's line waits on a person: a decision only a person
may take, a merge, a step by hand. Each such wait is a
[need](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). Without a
shared form for it, a person reads each one in a different place and
answers in their own words, and the next session works out which option
they meant: no program can tell which option was chosen, and nothing ties
an answer to the question it answers. So a need carries a
[framed decision](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
one record with the question, the options, what each changes and costs,
and the option recommended. A person answers it in a word, as a
[structured answer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
and every reader finds the same option in that word.

This chapter lists:

- **The decision record** (`parked-decision/v1`), and its JSON Schema,
  [schemas/parked-decision.json](schemas/parked-decision.json).
- **The answer**: the lines it is written in, its forms, how its text
  is normalized before it is compared, and the limits on it.
- **What a need asks of a person**: the
  [act](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) of each
  [decision class](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  Jig knows.
- **The dispatcher's own framings**: the key each kind of need it frames is
  answered by, and the options the tick carries out.

Besides Jig's own scripts (a drive's re-arm and the dispatcher's tick, which
read the answers), the dispatch dashboard, `jig ask`, `jig send` and a
workspace app's panel read these values to show a decision, offer its
options and write an answer. How the forms came about and why:
[design/structured-answers.md](https://github.com/jig-harness/jig/blob/main/design/structured-answers.md).

## The decision record

A decision record is a JSON document. These write it:

- a drive's pass that
  [parks](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) an item
  for a person (`drive-state.ts park`); the drive keeps it with the parked
  item, and its [ledger](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  publishes it on the pull request;
- a dispatched follow-up's or pickup's pass that stops for a person
  (`jig dispatch result … failed --decision <file>`, or the `decision` of
  its closing report); the dispatcher keeps it with the launch record;
- the dispatcher's tick, which frames a decision of its own for a cause it
  finds (below).

Each is kept with its
[decision digest](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
computed once, when it is stored, and published beside it; no reader
computes it again. A writer's record passes a strict check that refuses a
field this chapter does not list, an empty text, a question that is not one
line ending with `?`, an option id that is not one to eight letters or
digits or is used twice, fewer than two options, a recommendation that
names no option, and option names that are the same once normalized or that
redaction would change. A stored record is read more loosely: its text may
have been redacted since, so a reader checks only the fields' presence and
types, and reads past a field it does not know. The schema states that
reading. A reader that meets a record the schema refuses does not read it
as a decision, and never guesses what it meant.

The decision sheets of `/jig:decide` share the option's fields with the
record.

<!-- protocol:generated source=plugin/shared/decisions/decision-values.ts#PARKED_DECISION_FIELDS -->

| Field | Type | Carried | Meaning |
| --- | --- | --- | --- |
| `schema` | string | always | Always `parked-decision/v1`: a reader that meets another value does not read the record as a decision. |
| `class` | string | always | The decision class the decision falls in: a class of the repository's human-in-the-loop registry, or one of the dispatcher's own framings. Its act is in the classes table below; a class that table does not list asks a person to decide. |
| `call` | object | always | The question, its options and the recommended option. |
| `call.id` | string | always | The call's id: one to eight letters or digits. |
| `call.question` | string | always | The question a person answers: one line, ending with `?`. |
| `call.options` | object[] | always | The options a person chooses from, at least two, in the order the decision gives them. A refusal or a wait is an option of its own. |
| `call.options[].id` | string | always | The option's id, one to eight letters or digits, unique within the call: `call.recommended` names an option by it. |
| `call.options[].name` | string | always | The option's name on one line: what `choose <option>` names. No two options' names are the same once normalized, so a `choose` never names two options. |
| `call.options[].summary` | string | always | What choosing the option changes. |
| `call.options[].pay` | string[] | always | What choosing the option costs, at least one entry. |
| `call.options[].tag` | string | sometimes | A short label shown with the option. |
| `call.options[].keep` | string[] | sometimes | What the option keeps as it is. |
| `call.options[].rightWhen` | string | sometimes | When the option is the right one. |
| `call.options[].obligation` | string | sometimes | What choosing the option obliges someone to do afterwards. |
| `call.options[].reversible` | boolean | sometimes | Whether what the option does can be undone. A card asks for a second step before it commits a pick of an option marked `false`. |
| `call.recommended` | string | always | The id of the option the decision recommends: the option `approve` chooses. |
| `call.why` | string | always | Why the decision recommends that option. |
| `steps` | string[] | always | What a person must do by hand whichever option is chosen; empty when there is nothing. |
| `alreadyDone` | string | always | What the session that framed the decision already did about it. |
| `facts` | object[] | sometimes | Facts the decision rests on, each with where it was found. |
| `facts[].text` | string | always | The fact. |
| `facts[].source` | string | always | Where the fact was found: a file and line, a link, a command. |
| `interplay` | object[] | sometimes | How this decision bears on others, entry by entry: what settling one means for another. |
| `interplay[].from` | string | always | What the entry starts from, in free text: a call's id, another decision, an issue or a decision record. |
| `interplay[].to` | string | always | What the entry bears on, in the same free text as `from`. |
| `interplay[].text` | string | always | How the one shrinks or sharpens the other. |
| `sheet` | string | sometimes | The address of a decision sheet that sets the decision out at length: an https URL. |

<!-- /protocol:generated -->

## Answering a decision

A person answers in a comment on the pull request, or on the item when the
need is an item's, from an author the forge or tracker trusts, written later
than the decision was framed. Each line `answer <key>: <text>` outside a code
block answers the decision parked under `<key>`; in a reply on a parked
review thread, the reply's one line may be the text alone.

<!-- protocol:generated source=plugin/shared/decisions/decision-values.ts#ANSWER_LINES -->

| Line | Written | Meaning |
| --- | --- | --- |
| `answer` | `answer <key>: <text>` | Answers the decision parked under `<key>` with `<text>`: a structured answer when the comment holds nothing but answer and note lines (and blank lines, `jig send`'s record and quotes of the notification), and the text is one of the forms; otherwise a free answer. |
| `note` | `note <key>: <text>` | Adds the person's own words to the structured answer to `<key>` beside it, which may narrow the option chosen or set a condition on it, never widen it. A note with no answer beside it answers nothing. |

<!-- /protocol:generated -->

The text is a structured answer when, its trailing digest taken off and
normalized, it is exactly one of these forms. Anything else is a **free
answer**, read in the person's own words by the session the answer goes to:
`approve, but keep the old flag`, a `choose` that names no option, a
comment with a line of prose beside its answer lines. `jig ask` and the
dashboard label it free, so a person who meant a structured answer sees it
was not read as one. There is no form that declines: refusing what one
option allows is choosing another, and a decision whose act is Authorize
offers its refusal as an option of its own.

<!-- protocol:generated source=plugin/shared/decisions/decision-values.ts#ANSWER_FORMS -->

| Form | Written | Meaning |
| --- | --- | --- |
| `approve` | `approve` | Chooses the option the decision recommends. On a decision that recommends no option it is a free answer. |
| `choose` | `choose <option>` | Chooses the option whose normalized name is `<option>`. A name no option of the decision has makes it a free answer. |

<!-- /protocol:generated -->

A structured answer ends with the digest of the framing the person read,
in square brackets: `answer drive: approve [3fa9c2d1e0b4]`. A reader takes
a trailing digest off before it reads the form. An answer naming a digest
that is not the decision's current one is **stale**: it settles nothing and
the decision waits, so an approval of an earlier framing never settles the
one that replaced it. An answer naming no digest is bound by its time alone on a parked question;
on a dispatcher need, a structured answer naming no digest is stale and
settles nothing.
Every line Jig offers to copy, and every answer `jig send` writes, carries
the digest. On the forge, and on a tracker's item when the sender may be the
user the dispatcher's own tracker credential acts as, `jig send` also writes
a hidden record beside the line, listed in
[the hidden comment markers' chapter](comment-markers.md) as `drive-answer`.
A dispatcher reads a comment by its own forge login or tracker user as an
answer to a need's decision only with that record, naming that identity, the
decision's key and digest and the option the line chooses.

Each person's latest answer counts, its time being when its comment was
last edited. When every person's latest answer chooses the same option with
the same note, that option is chosen; when all are free, every one is
handed on; any other mix leaves the decision **disputed**, and it waits for
the people answering to agree.

A person's answer and every option's name are normalized the same way before
they are compared, in this order, so a phone's typography still matches:

<!-- protocol:generated source=plugin/shared/decisions/answer-normalize.ts#ANSWER_NORMALIZATION -->

| Step | Name | Meaning |
| --- | --- | --- |
| 1 | `compatibility` | Applies Unicode's compatibility normalization (NFKC): full-width letters and other compatibility forms become their plain forms. |
| 2 | `case` | Folds every letter to lower case. |
| 3 | `quotes` | Turns typographic single quotes (U+2018 to U+201B) into `'` and double quotes (U+201C to U+201F) into `"`. |
| 4 | `dashes` | Turns hyphens and dashes (U+2010 to U+2015) and the minus sign (U+2212) into `-`. |
| 5 | `marks` | Removes backticks and the bold marks `**` and `__`, which a pasted or formatted answer may carry. |
| 6 | `white-space` | Reads every run of white space as one space, and drops white space at either end. |
| 7 | `final-stop` | Drops one full stop or exclamation mark at the end, which a phone's keyboard may add, and the space before it. |

<!-- /protocol:generated -->

<!-- protocol:generated source=plugin/shared/decisions/decision-values.ts#DECISION_LIMITS -->

| Limit | Value | Unit | Meaning |
| --- | --- | --- | --- |
| `answer-text` | 500 | characters | The longest an answer's or a note's text may be. A longer one, or one with a line break, another control character or a hidden marker (`<!--`), is not a structured answer, and `jig send` refuses to send it. |
| `digest` | 12 | hexadecimal characters | The length of a decision digest: the first characters of the SHA-256 of the decision record as stored, in canonical JSON, kept with the decision. An answer ends with its framing's digest in square brackets, `approve [3fa9c2d1e0b4]`; an answer naming another digest is stale and settles nothing, and one naming none is bound by its time alone. |
| `decision-bytes` | 8192 | bytes | The largest a decision record may be, as UTF-8 JSON. A park, a dispatched session's result and its closing report refuse a larger one. |

<!-- /protocol:generated -->

## What a need asks of a person

Every need opens with one act, from a closed list, so a reader sees what it
asks before reading it. A decision's act is its class's; a class this
chapter does not list (a repository may add classes of its own to its
human-in-the-loop registry) asks a person to decide.

<!-- protocol:generated source=plugin/shared/acts.ts#NEED_ACT_VALUES -->

| Act | Meaning |
| --- | --- |
| `Merge` | Merge the pull request: only a person merges. |
| `Decide` | Choose among the options the decision frames. |
| `Authorize` | Allow, or refuse, what only a person may allow; refusing is an option of the decision's own. |
| `Reply` | Answer a person's review thread. |
| `Do` | Perform steps by hand, outside the line. |
| `Investigate` | Look into what went wrong: a failure or a stall nobody framed as a decision. |

<!-- /protocol:generated -->

<!-- protocol:generated source=plugin/shared/acts.ts#CLASS_ACTS -->

| Class | Act | Meaning |
| --- | --- | --- |
| `scope` | `Decide` | Expand a pull request's scope. |
| `next-item` | `Decide` | Pick the next item from the computed ranking. |
| `reopen-or-waive` | `Decide` | Reopen an item on a rejecting verdict, or waive a missing acceptance review. |
| `escalated` | `Decide` | A review thread the review arbiter escalated with no recorded person's decision behind it. |
| `human-decision` | `Decide` | A fix that would change what the pull request records as a person's decision, or a decision only a person can take; a pass that cannot read the repository's policy parks every decision under it. |
| `merge` | `Merge` | Merge a pull request. |
| `ready` | `Authorize` | Mark a pull request ready for review. |
| `release` | `Authorize` | Release or promote to production. |
| `destructive` | `Authorize` | A destructive operation: data loss or a history rewrite. |
| `legal` | `Authorize` | A legal or data-protection sign-off. |
| `copy` | `Authorize` | Publish customer-facing copy. |
| `dark-dial` | `Authorize` | Flip a dial that is off by default. |
| `rules` | `Authorize` | Change the rules the agents follow: instructions and scaffolding. |
| `reviewer-posture` | `Authorize` | Promote an automated reviewer to blocking, or waive a failing advisory check. |
| `human-thread` | `Reply` | A person's review thread an agent may not overrule on its own, or a person's reversal of a provisional decision. |
| `followup-recovery` | `Decide` | The dispatcher's framing: how a follow-up that failed or whose claim went stale goes on. |
| `pickup-recovery` | `Decide` | The dispatcher's framing: how a pickup that stalled, stopped on a question or ended without moving its item goes on. |
| `checkout-recovery` | `Decide` | The dispatcher's framing: how a checkout another tree holds is freed for a launch. |
| `drive-recovery` | `Decide` | The dispatcher's framing: how a drive that handed its pull request to a person goes on. |
| `launch-recovery` | `Decide` | The dispatcher's framing: how a launch record no tick launches again is settled. |

<!-- /protocol:generated -->

A pick under a class whose act is not Decide, or of an option marked as one
that cannot be undone, takes a second step on the dashboard's card before
it is committed.

## The dispatcher's own framings

For a cause the dispatcher finds itself, its tick frames the decision from
the facts that identify that cause, never from a clock or a count, so its
digest stays the same while the facts do. It frames it under one of the
keys below, with a fixed set of options, and carries out the option a
person chooses once. Each set ends with `hold`, which does nothing and
hides the need until its facts change. An answer naming **Leave it to me**,
the name `hold` had before, still chooses it.

<!-- protocol:generated source=plugin/shared/decisions/station.ts#STATION_KEYS -->

| Key | Class | Options | Meaning |
| --- | --- | --- | --- |
| `followup` | `followup-recovery` | `rerun`, `done`, `hold` | A merged pull request's follow-up whose pass ended without recording done, or whose claim no session is joined to. |
| `release` | `release` | `gates`, `inspect`, `tag` | One untagged release, answered on its tracker item. |
| `pickup` | `pickup-recovery` | `release`, `hold` | A pickup that stalled, stopped on a question it did not frame, or ended without moving its item on. |
| `checkout` | `checkout-recovery` | `detach`, `hold` | A launch that waits because a checkout the workspace runtime does not list holds its branch and is in use. |
| `drive` | `drive-recovery` | `rearm`, `hold` | A drive that stopped and handed its pull request to a person. |
| `launch` | `launch-recovery` | `clear`, `hold` | A pending launch record that no tick launches again, or one of unknown process that holds a drive. |

<!-- /protocol:generated -->

<!-- protocol:generated source=plugin/shared/decisions/station.ts#STATION_OPTIONS -->

| Option | Name | Can be undone | Meaning |
| --- | --- | --- | --- |
| `rerun` | **Run it again** | — | The dispatcher releases the follow-up's claim (its marker comment), and a later tick starts the follow-up again once, with your note, when you add one, as a person's answer in its prompt. |
| `done` | **Record it done** | — | The dispatcher marks the follow-up's marker done and sets the pull request's followed-up label; nothing runs again. |
| `release` | **Release the claim** | — | The dispatcher moves the item back to the state a pickup starts from, so a later tick picks it up afresh in a new session. |
| `detach` | **Detach the checkout** | yes | The dispatcher detaches the checkout from its branch (its files and commits stay where they are), so the launch can take the branch. |
| `rearm` | **Re-arm the drive** | — | The dispatcher re-arms the drive once on the pull request's current head, as the rearm label does. |
| `clear` | **Clear the record** | — | The dispatcher clears the stuck launch record, as jig dispatch clear does, which frees its slot; a later tick may start its stage again. |
| `gates` | **Re-run the failed gates** | — | The dispatcher requests another run of the failed jobs on the releasing commit once. |
| `inspect` | **Investigate** | — | Take the tracker item and determine what is holding back the tag. |
| `tag` | **Tag it by hand** | — | Take the tracker item and create the tag by hand after checking it is safe to release. |
| `hold` | **I'll handle it — hide this card** | — | Nothing is done; the work stays where it is. The dispatcher hides this card for these facts and lists it again when they change. |

<!-- /protocol:generated -->

## Not yet in this chapter

- **The causes of a need and their classes.** The causes the dispatcher
  finds waiting on a person (a failed follow-up, a stalled pickup, a host
  fault, …), the act each asks for, and the classes of need they group
  into are being settled by plan item 50
  ([design/need-classes.md](https://github.com/jig-harness/jig/blob/main/design/need-classes.md)),
  which still adds and regroups causes. They join this chapter once their
  table settles.
- **How often a recommendation is approved.** The answered park's event in
  the dispatcher's outcome log, and the report per class built on it, are
  the last step of plan item 46.
- **An answer as `jig ask` shows it.** The JSON `jig ask` prints for a
  decision's answers has no schema yet.
