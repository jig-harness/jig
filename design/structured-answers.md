# Structured answers reference

A person can reply to a framed decision with `approve` to choose its
recommendation or with `choose <option>` to choose a named option. An
answer in the person's own words goes to the next pass for interpretation.
The [Jig Protocol](../plugin/protocol/needs-and-answers.md) defines the
decision record, answer forms and dispatcher's options.

## One decision model

A call holds one question, mutually exclusive options and a recommendation.
A parked decision holds one call and its context. A decision sheet can
hold several calls. See the
[decision record](../plugin/protocol/needs-and-answers.md#the-decision-record).

## Several answers to one item

Each trusted author's latest answer counts. If every answer is free text,
the next pass receives them all. If someone chooses a structured option,
the item waits for agreement on the option and note. A different option,
a different note or another person's free answer leaves it disputed.

## Binding an answer to its framing

A decision digest identifies the framing that a person read. Every
structured line Jig offers to copy carries it. A saved browser draft belongs
to that digest and, when both framings record a park time, the occurrence when
the decision was parked: reframing a decision, or parking the same wording
again, discards its saved pick, note and free answer. A draft from a legacy
line without a park time instead falls back to the digest, so it can survive an
identical re-park while that time is unavailable. A submitted answer is instead read only when its comment is newer
than the current park. A structured choice that names a digest must name the
current one; a digestless answer is bound by that time check alone for a parked
question. An older copied answer posted after a new park can therefore still be
read when the framing is unchanged. An answer naming an older digest is stale
and leaves the current decision waiting. See
[answering a decision](../plugin/protocol/needs-and-answers.md#answering-a-decision).

## Writing an answer

A written structured answer names the decision's key and the option by
its name or by approval of the recommendation. A separate note can narrow
what the next pass does. For bulk approval, the decision set token binds
the send to the keys and digests listed in the dry run. A changed set
requires a fresh dry run. See the
[answer forms](../plugin/protocol/needs-and-answers.md#answering-a-decision)
and the [operator commands](../plugin/skills/operator/SKILL.md).

## Picking an answer

A pick selects an option in the browser and can be undone. On the board,
the recommendation is first, and its number is only a shortcut. Committing
a pick on the board copies the answer line with the decision digest and
any note. A pick is guarded when its class is not a named `Decide` act or
its option is irreversible; it takes a confirmation step that shows the
option's changes and costs. With no pick, Copy keeps a person's free-text
answer when one is present; otherwise it leaves every option unselected and
copies the answer lines the person can complete. For a card with one decision
whose class names a `Decide` act and whose recommendation is reversible, Copy
instead supplies an approval of that recommendation only when no answer is
present and no earlier answer was dropped. See the [board
keys](dispatch-board.md).

## Showing what was decided

Today, `jig ask --thread` shows a trusted answer as its raw `answer <key>:`
line. It does not show the question's options or a resolved choice. When
the drive re-arms on an answer, its ledger records a resolution receipt for
the park occurrence, with the consumed answers and outcome. The
dispatcher’s outcome log counts approvals from those receipts. For a park
removed from an open ledger, the absence of a receipt records a removal
when the ledger has no indication that receipts were lost.

## Who may answer

The same trusted-author rule applies to structured and free answers.
The [pass trust boundary](plan.md#40-the-pass-trust-boundary-as-mechanisms)
plans to require proof of who gave the answer for attested classes. See also the [dashboard answering decision](../docs/adr/ADR-0019-the-dashboard-page-answers-as-the-person.md).

## Every need framed

A need may carry a decision framed by the session or by the dispatcher.
When no framing is available, the need shows the question in free text.

### Sessions frame their questions

A pickup or follow-up pass can record its question, options and
recommendation in its result. The next pass receives the chosen option
and any note. See [what a dispatched session leaves](dispatched-sessions.md).

### The tick frames what it detects

The dispatcher frames options for situations it can act on. It derives
the framing from the facts that identify the occurrence so its digest
stays stable while those facts hold. When a person chooses an option, the
dispatcher carries out the corresponding step once. See the
[dispatcher's own framings](../plugin/protocol/needs-and-answers.md#the-dispatchers-own-framings).
