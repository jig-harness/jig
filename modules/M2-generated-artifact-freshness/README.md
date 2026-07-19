# M2 — Generated-artifact freshness

**What problem this solves.** Repos accumulate files derived from other files:
API specs from route definitions, ORM types from migrations, doc indexes from
doc trees, dependency notices from lockfiles — and prose that states countable
facts ("we have 120 skills"). Each derived copy silently rots the moment its
source changes, and both humans and agents then act on the stale copy. This
module makes staleness mechanically impossible — or at least mechanically
loud.

## Invariant

> Nothing derived is trusted at rest. A derived file is either (a) not
> committed at all, (b) not committed but its would-be content is CI-checked
> against reality, or (c) committed with the full freshness triad: a
> regenerate script, a CI drift check that fails when stale, and a commit-time
> auto-regenerate-and-stage hook.

## The decision ladder: drop > check > commit

Ordered by preference — materializing a derived file at rest is a liability
(it can drift *and* it merge-conflicts when parallel branches both regenerate
it), so:

1. **Drop** — generate at build/consume time; never commit the artifact.
   Choose when no consumer needs the file in the repo.
2. **CI-check without committing** — for *derivable facts stated in prose*
   (counts, rosters, path references in instruction files): a CI job recomputes
   the fact and fails on mismatch, but no generated file is committed. This
   was a hard-won correction in the reference implementation: committed
   generated includes caused merge-conflict thrash across parallel worktrees
   and were replaced by commit-nothing checks.
3. **Commit + triad** — when consumers genuinely need the artifact at rest
   (published specs, generated types consumed by builds): regenerate script +
   drift gate in CI + auto-stage twin in the pre-commit hook, so local commits
   go out fresh and CI catches everything else.

For schema-like artifacts, the strongest drift check is **ephemeral replay**:
spin a throwaway database/container, replay the source of truth (migrations)
from scratch, dump, normalize, and compare — testing the *whole chain*, not
just file timestamps.

## Maturity levels

- **Lite** — inventory exists: every derived file in the repo is listed with
  its generator; hand-editing them is documented as forbidden.
- **Standard** — every committed derived file has the full triad; at least
  prose path-references in instruction files are checked to exist.
- **Strict** — derivable prose facts are CI-checked (commit-nothing);
  schema-like artifacts use ephemeral replay; the artifact inventory itself is
  generated and gated.

## Port status (Phase 2 remainder)

| Source (docomply `develop`) | Becomes |
|-----------------------------|---------|
| Generate → check → auto-stage triad instances (docs index, schema, error codes) | `reference/triad/` (one worked, generic example: generator + drift check + hook wiring) |
| Ephemeral-replay drift check (`tools/db/check-*` + ephemeral-postgres lib) | `reference/ephemeral-replay/` (genericized) |
| Derivable-fact CI check + referenced-path-exists check (P1-4, commit-nothing design) | `reference/prose-facts/` |

Still to write: `mappings.md` (CI-provider variants), `maturity.yaml`.
