# Unresolved-threads merge gate

The comment-resolution loop (address / reject / defer — see
[`PR-LIFECYCLE.md`](../../templates/PR-LIFECYCLE.md)) made mechanical: no PR
merges with an open review thread, and every non-fix resolution carries an
audit trail.

## Why it exists

A forge's branch protection can require "all conversations resolved," but that
is a bare boolean — it cannot distinguish a thread that was *addressed* from one
a bot (or an impatient author) marked resolved with no reason. The loop
contract says every thread reaches one of three terminal states, each leaving a
trail: **addressed** (a fix), **rejected** (a stated reason), **deferred** (a
filed follow-up). This gate reads a small forge-exported states file so it can
enforce the *trail*, not just the flag.

## Mechanism

One thread per line: `<thread-id> <state> [reason / reference]`.

| State | Rule |
|-------|------|
| `addressed` | passes **only** with a fix reference (commit / change linked) |
| `rejected` | passes **only** with a reason |
| `deferred` | passes **only** with a follow-up reference |
| `open` | fails — resolve it before merge |
| anything else | fails — unknown state (catches typo'd resolutions) |

An **empty** file means zero threads and passes. Blank lines and `#` comments
are ignored. Export the file empty when a PR has no threads rather than skipping
the gate — a skipped gate and a clean gate must not look the same.

## Where it runs

Wire it as a **merge gate**: a required [CI](../../../../GLOSSARY.md) check on the
PR, after the forge-export step produces the states file (recipes per forge in
[`mappings.md`](../../mappings.md) — GitHub review threads via GraphQL, GitLab
resolvable discussions). The two loop rules that are **not** an agent's call —
scope expansion and overruling a *human* thread — stay
[HITL](../../../../GLOSSARY.md); this gate enforces the mechanical half.

```sh
THREADS=pr-threads.txt ./check-threads-resolved.sh
```

## Files

| File | Role |
|------|------|
| `check-threads-resolved.sh` | the gate; states file via arg or `THREADS` |
| `test-check-threads-resolved.sh` | paired self-test |
| `fixtures/clean.txt` | all terminal with trails — must pass |
| `fixtures/open.txt` | an open thread — must fail |
| `fixtures/no-reason.txt` | trail-less rejection/deferral — must fail |
| `fixtures/no-fix-ref.txt` | `addressed` with no commit/change reference — must fail |
| `fixtures/unknown.txt` | a typo'd state — must fail |
| `fixtures/empty.txt` | no threads — must pass |

Run the self-test with `./test-check-threads-resolved.sh`.
