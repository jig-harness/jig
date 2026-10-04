# Required-phases gate

A [phase formula](../../templates/phase-formula.yaml)'s REQUIRED gates made
mechanical. Recurring multi-phase work (research → architecture → build →
staging → production, say) has phases that must not be skipped. This gate
refuses to let a work item be **closed** while a phase the formula marks
`required: true` is not on record — the same *validate-then-gate* shape as
[M8](../../../M8-learning-loop/)'s corpus, applied to a work item's lifecycle.

## What it enforces

Given a formula (which phases are required) and a work-item **phase record** (its
status plus the phases completed):

| Situation | Result |
|-----------|--------|
| status is a **done** state and every required phase is recorded | **pass** (exit 0) |
| status is a **done** state but a required phase is missing | **fail** (exit 1) — the item is closing before a required gate |
| status is **not** a done state | **pass** (exit 0) — the item is not yet claiming completion, so there is nothing to gate |
| no `status:` line, or the formula declares no phases | **error** (exit 2) — malformed input |

What counts as "done" is the `DONE_STATES` env list (default `done closed
merged`) so it maps onto whatever terminal status your tracker uses.

## Input formats

The **formula** is `phase-formula.yaml`: a `phases:` list where each entry has
an `id` and `required` (bool). The **record** is a plain text file: a
`status: <value>` line plus the completed phase ids, one per line (blank lines
and `#` comments ignored; a leading `- ` or a `phase:` prefix is tolerated).
Export the record from your tracker — recipes in
[`../../mappings.md`](../../mappings.md).

## Mechanism

Portable Bun + TypeScript (no shell utilities required).

```sh
RECORD=work-101.txt FORMULA=phase-formula.yaml bun ./check-formula.ts
# or
bun ./check-formula.ts work-101.txt phase-formula.yaml
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate at close/merge time, or a status-transition
automation in the tracker (the authority — see
[M1](../../../M1-gates-enforcement-ladder/)).

## Files

| File | Role |
|------|------|
| `check-formula.ts` | the gate; `RECORD` + `FORMULA` select inputs, `DONE_STATES` the terminal states |
| `check-formula.test.ts` | paired self-test |
| `fixtures/formula.yaml` | the shared formula (two required phases) |
| `fixtures/good/` | records that must pass (complete-at-close, still-open, non-done status) |
| `fixtures/bad/` | records/formula that must fail or error |

Run the self-test with `bun test ./check-formula.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.
