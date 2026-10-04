# Label-taxonomy lint

The tasks-&-memory invariant made mechanical. A tracker's label set is only
useful if it is a disciplined [SSoT](../../../../GLOSSARY.md): a closed
vocabulary of types and statuses, plus [flag labels](../../../../GLOSSARY.md)
that each *fire* a named process. This gate keeps
[`label-taxonomy.yaml`](../../templates/label-taxonomy.yaml) honest so labels
stay process triggers, not folksonomy (labels that decorate but drive nothing).

## What it enforces

| Invariant | Why |
|-----------|-----|
| every label `id:` (in `types`, `statuses`, or `flags`) is **unique** across the file | a duplicate id makes a reference to it ambiguous |
| `types:` and `statuses:` are **closed, non-empty** lists | they are the mandatory vocabulary every issue draws from; an absent or empty list classifies nothing |
| every `flags:` entry declares a **non-empty `fires:`** | a flag label with no process trigger is folksonomy — the one thing this module bans |
| no **unknown** top-level keys | the schema is closed (`version` / `types` / `statuses` / `flags`) so it can't quietly grow a fourth meaning |

The `fires:` rule is the heart: it is what makes a label a *trigger* (a
`has-migration` label that fires a migration review) rather than a sticky note.

## Mechanism

Portable Bun + TypeScript (no shell utilities required). It reads the top-level keys and every
`- ` list entry, then checks each against the table above.

```sh
TAXONOMY=label-taxonomy.yaml bun ./check-label-taxonomy.ts
# or
bun ./check-label-taxonomy.ts label-taxonomy.yaml
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate on any change to the taxonomy (the
authority — see [M1](../../../M1-gates-enforcement-ladder/)); a pre-commit run is
a convenience. It is cheap enough to always-run.

## Files

| File | Role |
|------|------|
| `check-label-taxonomy.ts` | the gate; `TAXONOMY` selects the input |
| `check-label-taxonomy.test.ts` | paired self-test |
| `fixtures/good/label-taxonomy.yaml` | a valid taxonomy — must pass |
| `fixtures/bad/` | one file per broken invariant — each must fail |

Run the self-test with `bun test ./check-label-taxonomy.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.
