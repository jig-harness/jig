# M1 — Gates & enforcement ladder

**What problem this solves.** Most teams have more rules than enforcement:
"we always run the tests," "we never commit secrets," "new files need tests."
Whatever isn't mechanically checked erodes — especially with AI agents
generating high volumes of plausible-looking change. This module is the
machinery that turns stated rules into checks, ordered along an explicit
ladder from convention to hard gate, without collapsing into bureaucracy.

## Invariant

> A canonical, ordered set of quality gates is stated in one place and
> enforced at (at least) two rungs: locally via git hooks for fast feedback,
> and in CI as the authority. Every additional rule names its rung; every gate
> has a tested implementation and a documented, justified escape hatch.

## Core pieces

1. **The gate set** — the ordered commands (format → lint → types → tests →
   build) stated once (in the M0 instruction file) and identical everywhere
   they run.
2. **Hook layer** — pre-commit: auto-fixing checks that fix-and-stage
   (formatting, regeneration); pre-push: cheap pattern gates + the heavy
   build/test; commit-msg: process markers (e.g., "this migration was
   reviewed" tokens that a later gate verifies).
3. **Grep-gate framework** — one small script per codebase-wide rule
   ("no direct fetch calls in frontend", "no DML in migrations"), each with a
   paired self-test and fixtures, wired into both pre-push and CI. Simple
   beats clever: a grep with a self-test outlives an unowned AST analyzer.
   A rule that needs the code's structure rather than its text can be a
   lint-rule plugin instead (for example a [GritQL](../../GLOSSARY.md) rule
   run by the linter), on the same terms: the linter is pinned and each rule
   has its own fixtures and self-test. Each linter's mechanism is in
   [mappings.md](mappings.md#custom-lint-rules-and-the-ratchet).
4. **CI as authority** — every hook-enforced check re-runs in CI; local
   bypasses (`--no-verify`) exist for emergencies but change nothing about
   what merges.
5. **Suppression-token registry** — the documented set of inline markers that
   legitimately silence a specific gate at a specific spot, each with required
   justification. Ad-hoc suppressions are drift.
6. **Advisory→blocking pipeline** — new gates may start advisory, but each
   advisory gate carries a promotion condition; advisory-forever is a tracked
   smell. Between the two sits the [ratchet](../../GLOSSARY.md): a rule
   with existing findings blocks only changes that add to them, measured
   against the merge base, and is promoted to blocking when its count reaches
   zero.
7. **Third-party automation integrity** — external CI actions and included
   automation are pinned to immutable revisions, while an automated dependency
   updater proposes tested pin changes. An immutable pin without an update
   path becomes stale; an update bot without immutable pins leaves merge-time
   behavior changeable outside the reviewed commit.

## Maturity levels

- **Lite** — gate set documented + runnable with one command; hooks optional;
  CI runs the gates on every PR.
- **Standard** — full hook layer with auto-fix-and-stage; ≥ the team's top-5
  codebase rules as tested grep gates in hooks + CI; escape hatches
  documented; third-party CI automation is immutable and automatically
  updated.
- **Strict** — suppression-token registry; commit-msg process markers for
  mandatory reviews; gate self-tests required; advisory gates carry promotion
  conditions with dates; cross-worktree resource mutex where parallel agents
  share a machine (see M12).

## Adoption steps

1. Write the ordered gate set once in the universal instruction file
   ([M0](../M0-instruction-architecture/)), make one command run all of it,
   and run that command in CI on every pull request as a required check
   (skeleton: [`templates/ci-pr-gates.yml`](templates/ci-pr-gates.yml)). This
   is **Lite**.
2. Add the hook layer from [`templates/lefthook.yml`](templates/lefthook.yml)
   (husky and pre-commit equivalents in [`mappings.md`](mappings.md)); turn
   your top codebase rules into grep gates with self-tests, following
   [`reference/grep-gate/`](reference/grep-gate/), and run them in both the
   pre-push hook and CI; document the `--no-verify` escape hatch next to the
   hooks; pin third-party CI automation to immutable revisions and configure
   an updater for the pins. This is **Standard**.
3. Copy [`templates/suppression-registry.md`](templates/suppression-registry.md)
   and register every suppression token; add commit-msg markers for mandatory
   reviews with [`reference/commit-msg-marker/`](reference/commit-msg-marker/);
   run every gate's self-test in CI; give each advisory gate a promotion
   condition and a date. This is **Strict**.

## Status

What this module provides:

- [`templates/lefthook.yml`](templates/lefthook.yml) — the hook layer's shape:
  fix-and-stage pre-commit, pre-push grep gates then the heavy phase,
  commit-msg markers.
- [`templates/ci-pr-gates.yml`](templates/ci-pr-gates.yml) — a GitHub Actions
  pull-request workflow: one resolver job that selects the work from the
  change-area catalog ([M3](../M3-change-area-catalog/)), grep gates with
  their self-tests first, the gate set, tests on a parallel runner, a timeout
  on every job, and one aggregator job that is the only required check.
- [`templates/suppression-registry.md`](templates/suppression-registry.md) —
  the registry page for suppression tokens and process markers.
- [`reference/grep-gate/`](reference/grep-gate/) — the grep-gate convention
  with one worked gate (a TODO must cite an issue) and its fixtures.
- [`reference/commit-msg-marker/`](reference/commit-msg-marker/) — the
  commit-msg hook script for review markers, with its design notes.
- [`reference/ratchet/`](reference/ratchet/) — the ratchet gate: counts
  findings per rule in the working tree and the merge base, fails when a
  count grows or a configuration loosens a rule, and reports rules ready for
  promotion; with its self-tests.
- [`mappings.md`](mappings.md) — hook managers (lefthook, husky, pre-commit),
  CI providers (GitHub Actions, GitLab CI) and pin-and-update providers; and
  the module's [maturity criteria](../../plugin/skills/audit/criteria/M1-gates-enforcement-ladder.yaml).

The self-tests for the grep gate and the commit-msg marker are in
[`scripts/freshness.test.ts`](../../scripts/freshness.test.ts); the
ratchet's are in [`reference/ratchet/`](reference/ratchet/) beside the gate. Jig runs
this module on itself: `bun run gates` runs the repository's gate set in order,
CI runs the same command on every pull request, and the order is stated in the
root [`AGENTS.md`](../../AGENTS.md). Its ratchet covers Biome's warnings
(including Jig's GritQL rules in `tools/quality/grit/`), the compiler flags
being burned down and suppression comments. The
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md)
skill checks workflow changes against this module's pin-and-update invariant,
and [`/jig:fix-ci`](../../plugin/skills/fix-ci/SKILL.md) repairs a red
gate run from its log and verifies the fix locally before pushing.

Third-party automation integrity (core piece 7) is stated as the invariant,
the provider table in [`mappings.md`](mappings.md#immutable-third-party-automation-and-updates)
and a Standard criterion; it has no reference script.
