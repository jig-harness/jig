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
| every `flags:` entry declares **`scope:`**, either `shipping-item` (the work item whose change ships: a sub-issue, or an item with no children) or `container` (the container itself, such as an epic) | it makes "gate flags go on the item whose change ships, never on the container holding it" checkable per flag |
| every `flags:` entry declares a **non-empty `apply_when:`**; an optional `do_not_apply_when:` is non-empty when present | they make applying a flag a written rule rather than habit |
| every id in a flag's optional **`requires:`** is a type or another flag in the same file | it keeps a dependent label (a facet of another flag) from appearing alone |
| no **unknown** top-level keys | the schema is closed (`version` / `types` / `statuses` / `flags`) so it can't quietly grow a fourth meaning |

The `fires:` rule is the heart: it is what makes a label a *trigger* (a
`has-migration` label that fires a migration review) rather than a sticky note.

## Mechanism

Portable Bun + TypeScript (no shell utilities required). It parses the file
as YAML, then checks the top-level keys and every list entry against the
table above. Any YAML spelling of an entry is read alike: flow or block,
quoted or plain keys, a nested list or a folded multi-line text. A field must
be a single text or a list of non-empty texts, and an `id:` a single text;
any other value (a null list member, a list-valued id) is reported rather
than read as absent. No mapping may repeat a key.

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

The native gate uses the shared implementation in Jig’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts), which parses the
taxonomy with the js-yaml build vendored in `lib/vendor/`, which rejects a
repeated key. Keep the module and `lib/`, its `vendor/` folder included,
together when adopting it, as a pinned Jig checkout does.
