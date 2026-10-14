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
   the fact and fails on mismatch, but no generated file is committed.
   Committed generated includes are the tempting alternative, and they fail:
   every parallel branch that touches their inputs regenerates them, so every
   merge conflicts on the generated file.
3. **Commit + triad** — when consumers genuinely need the artifact at rest
   (published specs, generated types consumed by builds): regenerate script +
   drift gate in CI + auto-stage twin in the pre-commit hook, so local commits
   go out fresh and CI catches everything else.

For schema-like artifacts, the strongest drift check is **ephemeral replay**:
spin a throwaway database/container, replay the source of truth (migrations)
from scratch, dump, normalize, and compare — testing the *whole chain*, not
just file timestamps.

A [change-area catalog](../M3-change-area-catalog/)'s `generated:` field
couples a generated artifact to the area that owns it, so an area on the
shallow [validation profile](../../GLOSSARY.md) can carry this module's
freshness gate without escalating to full code validation, and the regenerate
command isn't duplicated across a hook, CI, and prose.

## Maturity levels

- **Lite** — inventory exists: every derived file in the repo is listed with
  its generator; hand-editing them is documented as forbidden.
- **Standard** — every committed derived file has the full triad; at least
  prose path-references in instruction files are checked to exist.
- **Strict** — derivable prose facts are CI-checked (commit-nothing);
  schema-like artifacts use ephemeral replay; the artifact inventory itself is
  generated and gated.

## Adoption steps

1. List every derived file in the repository with the command that
   regenerates it, in one place, and state that derived files are never edited
   by hand; give each derived file a generated-file header naming its
   regenerate command. This is **Lite**.
2. For each derived file, walk the ladder: drop it if no consumer needs it at
   rest; otherwise give it the full triad
   ([`reference/triad/`](reference/triad/)). Check the paths that instruction
   files reference with
   [`reference/prose-facts/check-referenced-paths.ts`](reference/prose-facts/check-referenced-paths.ts).
   This is **Standard**.
3. Check stated counts with
   [`reference/prose-facts/check-stated-counts.ts`](reference/prose-facts/check-stated-counts.ts),
   replay schema-like artifacts from scratch
   ([`reference/ephemeral-replay/`](reference/ephemeral-replay/)), and
   generate the derived-file inventory itself with a freshness gate. This is
   **Strict**.

## Status

What this module provides:

- [`reference/triad/`](reference/triad/) — a worked freshness triad: a
  deterministic index generator, its drift check and a fixture, with the hook
  and CI wiring.
- [`reference/prose-facts/`](reference/prose-facts/) — the two commit-nothing
  checks (stated counts, referenced paths) and a fixture.
- [`reference/ephemeral-replay/`](reference/ephemeral-replay/) — a schema
  drift check that replays migrations into a throwaway Postgres container
  with docker, plus the normalization and operational lessons.
- [`mappings.md`](mappings.md) (CI providers, hook managers, container and
  database variants) and the module's [maturity criteria](../../plugin/skills/audit/criteria/M2-generated-artifact-freshness.yaml).

The self-tests for all three references are in
[`scripts/freshness.test.ts`](../../scripts/freshness.test.ts). The
[`/jig:fix-ci`](../../plugin/skills/fix-ci/SKILL.md) skill uses this
module's vocabulary when a drift check fails: it finds the regenerate command
beside the check and runs it.

Deliberately left out: further triad instances (error-code catalogs, seed
data), because they would add domain values without adding mechanism — the
worked index example carries the whole pattern.

Future: a generic generator for the derived-file inventory. The Strict
criterion that requires one is stated in the module's [maturity criteria](../../plugin/skills/audit/criteria/M2-generated-artifact-freshness.yaml).
