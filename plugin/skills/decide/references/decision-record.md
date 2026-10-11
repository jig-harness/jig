# The decision record

What a `/decide` ruling must contain, and why each field is load-bearing. This
is the artifact phase 4 routes — as an issue comment, as the body of an
escalation issue, or (rarely) as the Context/Decision of an ADR (architecture
decision record).

The template below applies to a ruling that actually reaches phase 4:
`decided`, `escalated`, `human-decided`, or `underdetermined`. `human-decided`
is not one of phase 3's ladder outcomes — it is the state `escalated`
transitions to once the human resolves the call, posted as the follow-up
ruling comment [`human-call-elaboration.md`](human-call-elaboration.md)
promises, reusing this same template on the same issue the `escalated`
verdict opened. `already-decided` stops in
phase 1 with a citation and produces no record at all — `SKILL.md`'s own
"Ways phase 1 can end" is explicit that there is "no phase 2, no phase 3, and
nothing to record" for it. (`no-searchable-terms` stops even earlier, before
any search ran at all, and is not a phase-4 verdict either — see that same
section.) `already-decided` is still listed in the verdict table
below, because the table is the complete vocabulary a reader needs to
recognize a verdict wherever one is cited — not because it fills out this
template.

The shape is fixed so rulings stay comparable and re-auditable. A ruling whose
outcome has to be inferred from prose is one nobody can count, revisit, or
honestly reverse — the same reason PR review replies carry outcome tokens.

## Template

One fixed shape, reused by every verdict that reaches it — but several
fields carry a different **meaning** depending on which verdict fills them in,
because `decided` makes a call, `escalated` makes a recommendation nobody has
approved yet, and `underdetermined` makes neither. Filling in `decided`'s
wording for an `escalated` or `underdetermined` record would misrepresent
which of those actually happened — see the per-verdict notes after the
`Options considered` and `Why this one` fields below.

```markdown
**decision: `<verdict>`** — <the call for `decided`/`human-decided`; the
recommendation for `escalated`; the missing evidence for `underdetermined`, in
one sentence>

**Question**: <restated in canonical vocabulary, narrowed to what was contested>

**Ruled**: <YYYY-MM-DD> · **Evidence current as of**: <YYYY-MM-DD>
**Passes**: <single architect pass | architect + adversarial second pass |
human ruling on an escalated recommendation — `human-decided` | none —
`underdetermined`, no ruling was taken>

**Precedent searched**: <N ADRs, M policy sections, K rules>
<one of:>
- Read and dismissed: `<file:line>` — <why it does not reach this question>
- Nothing above the noise floor for terms [<terms>]

(Not "Settles it: …" — a precedent that settles the question is the
`already-decided` outcome, which stops in phase 1 and never reaches this
template at all; see the intro above.)

**Options considered**
| Option | Would win if | Rests on |
|---|---|---|
| A (chosen for `decided`/`human-decided` · recommended for `escalated`) | <condition> | `<file:line>` |
| B | <condition> | `<file:line>` |

For `underdetermined`, replace this table with the evidence that does not yet
exist: what question would have to be answered, and how, before any option
could be scored at all.

**Why this one**: <for `decided`/`human-decided`, the trade-off actually
made; for `escalated`, why this option is being recommended — not why it was
chosen, since nothing here is chosen; for `underdetermined`, omit this field>

**Human calls needed** (`escalated` only, and only when the escalation splits
into more than one open sub-call): <a short, lettered list — (a), (b), (c) —
each naming one open call in a phrase, not a paragraph. Omit the field
entirely for a single-call escalation or for `decided`/`human-decided`/
`underdetermined`.>

**Reverses if**: <for `decided`/`human-decided`/`escalated`, the concrete
condition that would make this the wrong call; for `underdetermined`, there is
no call to reverse — replace with **Resolves if**: the evidence that would let
this be decided>

**Sensitivity**: <none | has-migration, api-change, dpa-relevant, manual-ops>
**Obligations inherited by the implementing work**: <gates, register updates, none>
```

## The verdicts

| Verdict | Means | Who ruled |
|---|---|---|
| `already-decided` | Existing precedent answers the question — no record produced, only a citation | Nobody — it was already answered |
| `decided` | Reversible within one pull request, no persisted-data or published-contract consequence, ruled by the architect agent | Agent |
| `escalated` | A sensitivity flag fires, or the call belongs to a stakeholder — a recommendation is made, the decision is not taken | Human |
| `human-decided` | An `escalated` call has since been ruled on by the human it was routed to — not a phase-3 outcome, but the state `escalated` transitions to once that ruling is posted | Human |
| `underdetermined` | The evidence to choose does not exist yet | Nobody — a spike is filed |

Use them literally, lowercase, as the `<verdict>` value the template's
opening `decision:` line fills in — not the record's literal first
characters, which are the fixed `**decision:` prefix per the template above.
`escalated` is not a softer `decided`: it says the decision has not been
taken, and a reader who treats a recommendation as a ruling will build on
something nobody approved. `human-decided` is what closes that gap: writing
`decided` for a human's ruling would misattribute it to the architect agent,
and leaving the issue's verdict at `escalated` after the human has actually
ruled misstates that a decision is still pending — post the follow-up ruling
comment as `human-decided` on the same issue instead of reusing either.

## Field notes

**Question, restated.** Most dilemmas arrive with one contested clause wrapped
in three settled ones. Narrowing is what makes the record findable later — by
this skill's own phase-1 search, which is term-based and will not find a
ruling buried in a paragraph about something else.

**Two dates, not one.** *Ruled* is when the call was made. *Evidence current
as of* is when the facts under it were last verified. They are usually the
same on the day and diverge immediately afterwards, which is exactly the point:
a ruling revisited a year later needs to know how old its ground truth is. Audit
premises expire faster than the decisions built on them.

**Precedent searched.** Include the corpus counts even — especially — when
nothing was found. "I searched and found nothing" is evidence; "nothing
exists" is a claim nobody can check. Where candidates were read and dismissed,
say which, or the next session will read them again.

**Options.** Two or three real ones. A padded option makes the chosen one look
inevitable, which is a way of lying with a table.

**Would win if.** The conditions are what actually change over time —
constraints relax, volumes grow, a vendor ships the missing feature. A record
that lists only the winner cannot be revisited; it can only be overturned.

**Rests on.** `file:line` or an explicit zero-hit search, per the architect's
standing mandate (`SKILL.md` § The architect mandate). Plans routinely assert phantom tables and
"already exists" primitives with full confidence; a decision resting on one is
worse than no decision, because it will be cited.

**Reverses if.** The single most-skipped field and the one that makes a record
honest. If nothing could reverse it, it is not a decision — it is a
restatement of a constraint, and belongs in the constraint's own document.

**Human calls needed.** Only when an `escalated` recommendation actually
splits into distinct open questions — a single escalation doesn't need a
list naming itself. This is the field a human points at when they ask to see
the trade-offs on one of the calls rather than just the recommendation; see
[`human-call-elaboration.md`](human-call-elaboration.md) for that format.

**Tense.** When the decision precedes the work it authorises, write it in the
**future** tense throughout: "the worker **will** read from the queue", never
"the worker reads from the queue". A record is read as a description of the
system. Present tense in a record that lands ahead of its implementation is
simply false, and it breeds a second defect — an absolute present-tense claim
will contradict the record's own carve-outs.

## Where it lands

Phase 4's routing table in [`../SKILL.md`](../SKILL.md) decides. In short: a
comment on the live issue by default; an `hitl`-labelled issue for an
escalation; an ADR only when the decision constrains future code beyond the
change that prompted it, and then via `/groundwork:adr` so the
`adr-rules.yaml` extraction happens too.
