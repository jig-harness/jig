# Parity report

The learning loop's **measure** step made mechanical. A lens is kept, promoted,
or killed by measurement — not opinion — and a reviewer earns the right to
*block* only once its precision clears a bar. This gate turns a period's
reviewer-vs-oracle tallies into those two signals.

## What it computes

One row per reviewer: `<reviewer> <true_positives> <false_positives> <missed_blockers>`.

| Signal | Meaning | Effect |
|--------|---------|--------|
| `missed_blockers` | a real blocker an oracle caught that this reviewer did not | **fails the gate** — a regression signal: open a new lever, and a reason you cannot yet drop the oracle that caught it |
| precision | of the reviewer's findings, the share that were real | reported with a `promotable?` marker vs `MIN_PRECISION` — the evidence [M7](../../../M7-pr-lifecycle-review/) needs before flipping a lens from comment to blocking |
| recall | of the real blockers, the share this reviewer caught | reported (context for the missed-blocker signal) |

The **missed-blocker** rule is the hard one, and deliberately so: letting a
blocker through is the failure the whole flywheel exists to drive out. Low
precision does not fail the gate — it just withholds promotion, which is exactly
the [advisory gate](../../../../GLOSSARY.md) posture.

## Mechanism

Portable Bun + TypeScript (precision/recall arithmetic). Feed only the reviewers
you actually gate on; blank lines and `#` comments are ignored.

```sh
MIN_PRECISION=0.90 bun ./check-parity.ts parity.tsv
```

Produce `parity.tsv` from your telemetry or a weekly parity snapshot (recipes in
[`mappings.md`](../../mappings.md)).

## Where it runs

Typically a **scheduled** job (a weekly parity snapshot), not a per-PR gate — the
tallies accrue over a period. Wire its failure to reopen a lever and to feed
M7's promotion decision. [CI](../../../../GLOSSARY.md) is still the authority for
running it (see [M1](../../../M1-gates-enforcement-ladder/)).

## Files

| File | Role |
|------|------|
| `check-parity.ts` | the gate; `TALLIES` + `MIN_PRECISION` select inputs |
| `check-parity.test.ts` | paired self-test (exit code per fixture; the precision arithmetic is covered by the shared cases) |
| `fixtures/clean.tsv` | no missed blockers — must pass |
| `fixtures/missed.tsv` | a missed blocker — must fail |
| `fixtures/empty.tsv` | nothing tallied — must pass |
| `fixtures/bad-row.tsv` | a non-numeric column — must error |
| `fixtures/duplicate-reviewer.tsv` | the same reviewer tallied twice — must error |
| `fixtures/extra-column.tsv` | a fifth column (schema drift) — must error |

Run the self-test with `bun test ./check-parity.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.
