# Corpus-lint

The learning loop's invariants made mechanical. The eval
[corpus](../../../../GLOSSARY.md) — the set of past misses reconstructed as
replayable fixtures — is only as trustworthy as its discipline, and discipline
decays. This gate keeps the corpus honest so the blocking regression set never
quietly lies about what it proves.

## What it enforces

Per fixture in [`corpus.yaml`](../../templates/corpus.yaml):

| Invariant | Why |
|-----------|-----|
| lever id is `L-NNNN` and **unique** | levers are referenced forever; a duplicate makes references ambiguous (parallel authors collide on the next number just like [ADRs](../../../M5-adr-practice/)) |
| category is in the [miss taxonomy](../../templates/miss-taxonomy.yaml) | a typo'd category drops the miss out of every count |
| `pinned_commit` present | a fixture with nothing pinned tests nothing |
| `lens` present | every filed miss is answered by an additive lens — that is the loop |
| `required: true` ⇒ a dated `validated` record | the **validate-then-gate** rule: a fixture may not enter the *blocking* corpus until a live run proved the reviewer now catches it |

The last one is the heart: it is what stops an unvalidated fixture from being
promoted into the regression gate, where a green result would be theater.

## Mechanism

Portable bash + awk (no `yq` / python). It reads the taxonomy's category ids and
the corpus's fixtures, then checks each fixture against the table above. The
taxonomy defaults to `miss-taxonomy.yaml` beside the corpus; override with
`TAXONOMY=`.

```sh
CORPUS=corpus.yaml TAXONOMY=miss-taxonomy.yaml ./check-corpus.sh
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate on any change to the corpus or taxonomy (the
authority — see [M1](../../../M1-gates-enforcement-ladder/)); a pre-commit run
is a convenience. It is cheap enough to always-run.

## Files

| File | Role |
|------|------|
| `check-corpus.sh` | the gate; `CORPUS` + `TAXONOMY` select inputs |
| `test-check-corpus.sh` | paired self-test |
| `fixtures/good/` | a valid corpus — must pass |
| `fixtures/bad/` | one file per broken invariant — each must fail |
| `fixtures/miss-taxonomy.yaml` | the category vocabulary the fixtures resolve against |

Run the self-test with `./test-check-corpus.sh`.
