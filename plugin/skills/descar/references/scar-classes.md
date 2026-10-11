# Scar classes, the keep test, and where removed content goes

This is the de-scarring rule the `descar` skill applies when the repository's
own wiki schema does not spell it out in this detail. Where the repository's
schema does, the schema wins; where it is stricter (a register's own closure
rule, say), the stricter rule wins.

A promoted document is a clean statement of the **current truth**. The traces
of how it got there (review findings, corrections layered on corrections, the
state it described last quarter) are *scars*: they belong to the process, not
the document. A document may not move to, or remain at, a promoted status
while it carries scars.

The rule is not about style. A scarred document makes every reader, human or
agent, work out which of several stated claims is the live one, and readers
get it wrong. The worst case is a plan table whose cells strike a claim,
restate it, amend the restatement by date, then correct the amendment: the
current answer can then only be found by comparing struck with unstruck text.

## Scar classes

Each class says what it looks like, the remedy, and whether a text-matching
lint can see it. **A class the lint does not see is still a scar**: the lint's
silence is not a verdict.

| Class | What it looks like | Remedy | Detectable by a lint |
|-------|-------------------|--------|----------------------|
| **S1 — Review dialogue** | A reviewer or review-bot attribution inside the document (`Reviewer:`, a bot's quoted finding); resolution phrasing such as *"addressed"*, *"fixed as suggested"*, *"good catch"*, *"as per review"* | Delete. Git and the pull request thread already hold it | Partly. Field labels (`Reviewer:`) and resolution phrasing that opens a list or quote item are matchable; a bare *"addressed"* in ordinary prose, or a tool's name in a sentence about tooling, is not a hit and must not be |
| **S2 — Correction-in-place ledger** | A superseded statement struck (`~~old~~`) or left beside its replacement, stamped *"Corrected \<date\>"*, *"amended \<date\>"*, *"retracted, see below"*, *"withdrawn"*, *"(historical — see …)"* | State only the current claim. If a reader would be misled without knowing it changed, add one outcome-only line under `## Version history`, never both claims in the body | Partly. A struck correction is matchable; an unstruck *"Corrected \<date\>"* paragraph is not. A table that documents strikethrough syntax is not a correction |
| **S3 — Completed-work ledger** | A plan, checklist or register that strikes or ticks its own finished rows in place: `~~Database migration~~ — done`, `- [x] ~~done~~`, rows marked *"N/A"*, *"Superseded"*, *"Covered by …"* | Delete the row, subject to the closure invariant below, except in a completeness register (below), whose rows are never deleted under S3. A document that is *wholly* finished work is not a de-scarring case: its `status` or `lifecycle` is wrong; archive it | Partly. A struck row is matchable; a plain `- [x]`, *"N/A"* or *"Covered by …"* row is not |
| **S4 — Archaeological layer** | Prose describing a superseded state beside the current one: *"previously X, now Y"*, *"originally"*, *"formerly"*, *"used to"*, *"**Update:**"*, *"as of \<issue key\> this was renamed"*, each layer added by a later edit instead of replacing the earlier one | Rewrite the passage as one present-tense statement of what is true now. Route the fact that it changed per the table below | **No, deliberately.** See below |

**Why S4 is judgment-only.** Its wording does not separate scars from content
that must stay. Search any mature docs tree for *"no longer"* and many hits are
keepers: a security note that a database role named in an old decision *no
longer exists*, which is the premise of the table below it, not history. A
text-matching gate over this class would be defeated by one counterexample
after another, and no structural gate reads a sentence and checks it against
the code. S4 is found by reading.

## What is not a scar: the keep test

Past-tense prose is not the signal. Apply the **keep test**:

> Would a reader who has never seen the old state make a **wrong decision**
> without this sentence? No: it is a scar. Yes: it is current-state content.
> Keep it, and rewrite it in the present tense as a constraint rather than as
> a history.

These pass the keep test and must survive de-scarring:

- **Guardrails**: *"we tried X, it failed this way, do not reintroduce it"*.
  Negative knowledge is the most expensive kind to learn again, and deleting
  it is the largest single risk in a de-scarring pass. Restate it as a
  prohibition with its reason, not as a narrative.
- **Live drift**: a discrepancy between two sources of truth that still
  exists today. The older state matters because the stale source still says
  it.
- **Dated commitments**: deadlines, dates a rule takes effect, obligations,
  migration windows. A date in the past does not make these historical; it
  makes them overdue.

Two exemptions are structural, not judgment calls: architecture decision
records ([ADRs](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) record their evolution in the body by
design (an `## Amendments` section and `status: amended`; see
[M5](https://github.com/docomply/jig/blob/main/modules/M5-adr-practice/README.md)), and documents whose
*subject* is the review process are exempted from the lint by path or by
`descar_allow: true` in their frontmatter.

## Where removed content goes

Nothing that carries rationale is deleted: it is **moved**. Pick the
destination by what the content is:

| Content | Destination |
|---------|-------------|
| How a decision evolved | The ADR's `## Amendments` section (`status: amended`) |
| A whole document replaced by another | Archive the predecessor with `superseded_by:` pointing at the successor; the successor carries `supersedes:` pointing back. `archive/` and `superseded_by:` go on the *replaced* document, never on the current one, and only when a real successor exists |
| What changed within one document | A short `## Version history` section: *what* changed, dated; never reviewer names, resolution phrasing or struck text |
| What changed across documents, and why | The wiki's activity log (`log.md` in the [M4](https://github.com/docomply/jig/blob/main/modules/M4-docs-governance/README.md) layout): **one line per document per pass** |
| A companion record of findings | A review record, an audit document, a design-decisions note |
| The issue that tracked the change | Reference it by its key; do not restate its discussion |
| A completed-work (S3) row whose closure anchor is verified (below) | Nowhere: the anchor already **is** the durable record |
| Review dialogue and correction traces | Git history. Together with a closure-verified S3 row, **these are the only content deleted outright**. Rationale never goes here: git keeps it, but nobody searches git for it |

## Registers: the closure invariant, and the completeness-register exception

A backlog or obligation calendar states what is *outstanding*, not what was
done. Its completed rows leave, subject to the anchor below.

**A completeness register is different, and S3 deletion never applies to
it.** Some registers are not task lists but maintained statements of current
coverage, for example a register of every requirement a supplier contract
must address, whose `covered` rows people rely on today. Deleting such a row
does not archive finished work; it removes a claim someone is relying on.
Recognise this kind by the register's own stated purpose. Never delete its
rows under S3: correct a stale row in place, or report it as a false claim if
it no longer holds.

**In a genuinely future-facing register, deleting a row can delete the only
record that a control exists.** A completed row may be removed only when its
outcome has a durable anchor, and only when the register's own rules do not
ask for something narrower (some registers say that a closed issue is not
always a closed gap, and rewrite the row to its remaining part instead of
deleting it). The anchor is one of:

- the row names an issue in a **closed state**, *and* opening it confirms the
  gap itself is resolved: not descoped, not narrowed to a remainder, not
  closed for an unrelated reason; or
- the thing it delivered is **present in the corresponding source of truth**
  (a security backlog row against the security reference document, say).

**Fail closed**: no anchor, no deletion. The row stays, and the missing anchor
is the finding to report. Verifying an anchor means opening it, not inferring
it from the row's own text: a fix landing has repeatedly not meant that the
document asserting it was updated. Where the register's own rules ask for
narrowing to a remainder, narrow the row; a valid anchor does not override
that.
