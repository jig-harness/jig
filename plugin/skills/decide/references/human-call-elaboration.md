# Elaborating open human calls

When an `escalated` verdict (phase 3) leaves one or more open `hitl` calls —
named individually in the record's own "Human calls needed" field
([`decision-record.md`](decision-record.md)) when there is more than one, or
carried by the record's own recommendation itself when there is exactly one,
since that field is omitted for a single-call escalation — and a human then
asks to see the trade-offs on them, this is the format for that elaboration.
It is a different artifact from the decision record: that record fixes what
a *ruling* must contain once a call is made; this is what gets read *before*
the human makes one, when they ask for the trade-offs to be laid out rather
than just the recommendation.

## Contents

- [Format](#format)
- [Length discipline](#length-discipline)
- [Writing rules for text that asks a human to decide](#writing-rules-for-text-that-asks-a-human-to-decide)
- [Where the elaboration format applies](#where-the-elaboration-format-applies)

## Format

For each open call:

1. **One-line context sentence.** What the call is actually about, in the
   fewest words that still let a reader who has not re-read the whole record
   follow the rest.
2. **Any hidden branch, stated before the options.** A call sometimes turns
   on a fact that has not resolved yet, and that fact can change which
   options even apply — state it first. Example: "the spike can fail for
   fixable vs fundamental reasons — only the latter triggers this call."
3. **Per option, bullets in this fixed order:**
   - **What you keep / what you get** — the property preserved or gained.
   - **What you pay / what you accept** — the cost, named as concretely as
     what you keep, not a vague "some risk."
   - **When it is right** — the condition under which this option is the
     correct call, not merely an available one.
   - **Obligation**, only if choosing this option creates one (a follow-up
     gate, a document that must change, a coordination point) — omit the
     line entirely rather than writing "none."
4. **One-line "my read."** A recommendation, not a restatement of the
   options — say which one, and why, in one sentence.
5. **Cross-call interplay, stated explicitly.** If an earlier call (already
   decided) shrinks or sharpens this one, say so; do not make the reader
   reconstruct it from context.
6. **Non-recommended options, still listed.** Every alternative stays listed
   with the reason it was not recommended — not "declined" or "lost", since
   only the recommendation exists at this point and nothing has been ruled
   on yet — so the human can see it was weighed rather than silently
   dropped, the same discipline `decision-record.md`'s own "Options
   considered" table applies to the formal ruling.

## Length discipline

No headers for a batch under ~500 words total — the numbered structure above
already gives the reader a spine. Above that, one header per call (not per
bullet), so a long batch stays navigable without turning into a document.

## Writing rules for text that asks a human to decide

This section is the one canonical home of the writing rules. Every surface
that asks a human for a call links here and does not restate them. Those
surfaces are the `/groundwork:decide` escalations and elaborations, a
`groundwork:review-arbiter` `escalate` ruling, and any planning skill's
section on what the human must decide or review. The reader is often a
product, legal or business stakeholder. English may not be their first
language, so a long sentence costs the most for the person who has to decide.

The rules are the structural part of Simplified Technical English (the
`ASD-STE100` specification). Apply these:

- Write at most 20 words in an instruction sentence and at most 25 in a
  descriptive one.
- Use the active voice. Name who does the action.
- Use no semicolons. Use no phrasal verbs (a verb plus a particle that
  changes its meaning). Use one plain verb instead.
- Keep noun clusters to at most 3 words. Rewrite a long stack of nouns as a
  short phrase with a verb.
- Use one term for one concept, every time. Do not rotate several verbs for
  one action.
- Use no marketing adjectives, such as "seamless" or "robust". Give the
  measurement that earns the claim, or delete the word.
- Use the verb, not a noun made from it. Write "analyze", not "perform an
  analysis of".
- Use a list when 3 or more steps or conditions follow one another.
- Define each domain term once, where it first appears.
- **Keep every hedge.** "May have failed" says how sure the source is, and
  that is content. Never remove or strengthen one to shorten a sentence.
- **Add no fact the source does not state.** Rewriting for clarity changes the
  form of a claim and never its content or its confidence.

### Check before you post

Run the advisory linter over text you generated, before you post it. The
linter first joins each wrapped paragraph or list item into one line. A hard
wrap can split one sentence over several lines. The linter still measures it
as one sentence.

```bash
bun <skill-dir>/scripts/ste-lint/ste-lint.ts draft.md
# or: cat draft.md | bun <skill-dir>/scripts/ste-lint/ste-lint.ts --json
```

`<skill-dir>` is the directory of the `decide` skill (`${CLAUDE_SKILL_DIR}` in
`SKILL.md`).

Fix each flag, or say in the text why you kept it. A flag is a candidate for
a broken rule, not proof, because the linter matches patterns and does not
parse sentences. These flags are advice only: `passive-voice`,
`present-perfect` and `synonym-rotation`. The linter cannot tell an unknown
actor from a hidden one. It cannot tell two verbs for one action from two
verbs for two actions. The linter never flags hedges.

The linter is advisory. It exits `1` when it finds a hard flag. That exit code
informs the author and is never a reason to stop. No continuous-integration
workflow, hook or validation plan runs it on text that people write.
Provenance and licence of the upstream linter it derives from:
`<skill-dir>/scripts/ste-lint/README.md`.

## Where the elaboration format applies

- Phase 4 of `/decide`, whenever an `escalated` verdict leaves an open call
  and the human later asks to see its trade-offs.
- Phase 4 of `/decide`, at escalation time, when the call is above the
  decision-sheet threshold in [`SKILL.md`](../SKILL.md) § Phase 4. Then the
  elaboration is not written by hand. It is rendered from the same decision
  source as the sheet, so the two cannot disagree.
- A human-decision sub-issue in a planning skill's output, when its "what the
  human must decide or review" section is itself an `escalated` `/decide`
  call — an architectural fork goes through `/decide` rather than being parked
  in the sub-issue body. Most such sub-issues are user-experience, vendor or
  design calls with no decision record behind them at all.

This never substitutes for the decision record
([`decision-record.md`](decision-record.md)): the record is what gets routed
and cited later, while this elaboration is what gets a human to a decision in
the first place. The human's answer is not itself durable until a follow-up
ruling comment — verdict `human-decided`, reusing the record template on the
same issue — folds it, and the reasoning behind it, back onto the issue. The
template has one Question/Options/Why/Reverses-if per record, so when the
human resolves more than one open call at once, post one `human-decided`
record block per resolved call rather than merging them into a single
block — and leave any call the human did not answer yet listed in the
original record's "Human calls needed" field, unresolved.
