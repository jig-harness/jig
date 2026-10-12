# Verified-pointer freshness watchdog

A [freshness gate](../../../../GLOSSARY.md) on a *pointer* instead of a file. It
fails when post-merge verification stops keeping up, so a frozen `verified`
pointer pages someone (or triggers an automated heal) instead of quietly
shipping stale code forever.

## Why it exists

The delivery architecture (see [`../../templates/CI-ARCHITECTURE.md`](../../templates/CI-ARCHITECTURE.md))
advances an explicit `verified` pointer — a branch or tag — to the newest commit
that passed the full verification suite, and deploys **only** what `verified`
points at. That promise is only as good as verification's ability to keep up. If
the verifier wedges — a flaky suite, a dead runner, a stuck queue — `verified`
silently freezes while the default branch races ahead. "We deploy verified
artifacts" now means "we deploy last week's code," and nobody is paged, because
nothing *failed*: verification just stopped happening.

The self-healing idea is to make that silence loud. Treat the pointer's lag as a
monitored quantity, and fail a check when it crosses a threshold — the same move
[M2](../../../M2-generated-artifact-freshness/) makes for a generated file,
applied to a pointer's position in history.

## What it measures

Two independent lag signals; supply either or both:

| Signal | Meaning | Threshold (env) |
|--------|---------|-----------------|
| `BEHIND` | commits the `verified` pointer trails the default-branch tip | `MAX_BEHIND` (default `20`) |
| `AGE_SECONDS` | seconds the oldest commit not yet verified has waited (its committer time; `0` when the pointer is at the tip) | `MAX_AGE_SECONDS` (default `86400`, 24h) |

The pointer is **stalled** (exit `1`) if *either* supplied signal exceeds its
threshold; it is **fresh** (exit `0`) only if every supplied signal is at or
under threshold. At-threshold counts as fresh — only strictly-greater stalls.
Thresholds are validated up front (like `check-parity.ts` validates
`MIN_PRECISION`): a non-numeric or negative threshold is a usage error (exit
`2`), never a silently-passing check.

## Mechanism

Portable Bun/TypeScript. Feed the observation via env or an input file; derive
the numbers from git (recipes per forge in [`../../mappings.md`](../../mappings.md)):

```sh
BEHIND=$(git rev-list --count verified..origin/main)
OLDEST=$(git log --reverse --format=%ct verified..origin/main | head -n 1)
NOW=$(date +%s); AGE_SECONDS=$(( NOW - ${OLDEST:-$NOW} ))
BEHIND="$BEHIND" AGE_SECONDS="$AGE_SECONDS" \
  MAX_BEHIND=20 MAX_AGE_SECONDS=86400 bun ./check-verified-fresh.ts
```

An input file passes the same observation as `<KEY> <value>` lines (`BEHIND` /
`AGE_SECONDS`), so fixtures and cron snapshots can drive it without env.

## Where it runs

A **scheduled** job (every few minutes to hourly), not a per-PR gate — it watches
a background process, not a diff. Wire its failure to your pager and, ideally, to
an automatic heal run (re-kick verification from the current tip). [CI](../../../../GLOSSARY.md)
is still the authority for running it (see [M1](../../../M1-gates-enforcement-ladder/)).

## Files

| File | Role |
|------|------|
| `check-verified-fresh.ts` | the gate; `BEHIND` / `AGE_SECONDS` + `MAX_BEHIND` / `MAX_AGE_SECONDS`, or a file arg |
| `check-verified-fresh.test.ts` | paired self-test (exit codes, thresholds, file + env paths) |
| `fixtures/fresh.txt` | keeping up — must pass |
| `fixtures/boundary.txt` | exactly at threshold — must pass |
| `fixtures/stalled-behind.txt` | too far behind — must fail |
| `fixtures/stalled-age.txt` | oldest unverified commit waited too long — must fail |
| `fixtures/bad-value.txt` | non-numeric observation — must error |
| `fixtures/huge-value.txt` | a value beyond the 64-bit range — must error, not read as fresh |
| `fixtures/duplicate-key.txt` | the same key twice (a stall, then a fresh value) — must error, not let the last one win |
| `fixtures/unknown-key.txt` | an unrecognised key (schema drift) — must error |
| `fixtures/empty.txt` | no observation at all — must error |

Run the self-test with `bun test ./check-verified-fresh.test.ts`.

## Known limits

It scores a lag number you compute; it does not itself talk to git or your forge,
so a broken *collector* (one that reports `BEHIND=0` because it queried the wrong
ref) would look fresh. Keep the one-line collector next to the gate and test it,
the way the export step is checked in beside the gate in
[M7](../../../M7-pr-lifecycle-review/)'s mappings.
