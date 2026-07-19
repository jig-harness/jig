# ADR numbering gate

A tiny check that fails when two ADRs claim the same number. It exists because
next-number selection is inherently racy: an author reads the current highest
`ADR-NNNN` and adds one, so two agents on parallel branches pick the same
number, and the merge silently produces a duplicate. In the reference
implementation this happened for real and forced a renumbering — the gate is
the fix.

## Mechanism

List `ADR-*.md`, reduce each filename to its `ADR-NNNN` prefix, and report any
number that appears more than once (`sort | uniq -d`). Slugs are ignored —
`ADR-0007-a.md` and `ADR-0007-b.md` collide. Gaps are fine (a withdrawn ADR
leaves a hole).

## Mirror it on both rungs

Wire it into a **pre-push** hook for fast local feedback *and* into **CI** as
the authority — CI is what catches a duplicate pushed with `--no-verify` or by
automation that bypassed local hooks (see [M1](../../../M1-gates-enforcement-ladder/)).

```sh
ADR_DIR=docs/adr ./check-adr-numbers.sh
```

## Files

| File | Role |
|------|------|
| `check-adr-numbers.sh` | the gate; `ADR_DIR` selects the directory |
| `test-check-adr-numbers.sh` | paired self-test |
| `fixtures/unique/` | distinct numbers — must pass |
| `fixtures/dupe/` | two files sharing `ADR-0002` — must fail |

Run the self-test with `./test-check-adr-numbers.sh`.
