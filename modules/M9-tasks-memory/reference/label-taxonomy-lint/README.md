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

Portable bash + awk (no `yq` / python). It reads the top-level keys and every
`- ` list entry, then checks each against the table above.

```sh
TAXONOMY=label-taxonomy.yaml ./check-label-taxonomy.sh
# or
./check-label-taxonomy.sh label-taxonomy.yaml
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate on any change to the taxonomy (the
authority — see [M1](../../../M1-gates-enforcement-ladder/)); a pre-commit run is
a convenience. It is cheap enough to always-run.

## Files

| File | Role |
|------|------|
| `check-label-taxonomy.sh` | the gate; `TAXONOMY` selects the input |
| `test-check-label-taxonomy.sh` | paired self-test |
| `fixtures/good/label-taxonomy.yaml` | a valid taxonomy — must pass |
| `fixtures/bad/` | one file per broken invariant — each must fail |

Run the self-test with `./test-check-label-taxonomy.sh`.
