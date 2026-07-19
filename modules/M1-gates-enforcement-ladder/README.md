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
4. **CI as authority** — every hook-enforced check re-runs in CI; local
   bypasses (`--no-verify`) exist for emergencies but change nothing about
   what merges.
5. **Suppression-token registry** — the documented set of inline markers that
   legitimately silence a specific gate at a specific spot, each with required
   justification. Ad-hoc suppressions are drift.
6. **Advisory→blocking pipeline** — new gates may start advisory, but each
   advisory gate carries a promotion condition; advisory-forever is a tracked
   smell.

## Maturity levels

- **Lite** — gate set documented + runnable with one command; hooks optional;
  CI runs the gates on every PR.
- **Standard** — full hook layer with auto-fix-and-stage; ≥ the team's top-5
  codebase rules as tested grep gates in hooks + CI; escape hatches
  documented.
- **Strict** — suppression-token registry; commit-msg process markers for
  mandatory reviews; gate self-tests required; advisory gates carry promotion
  conditions with dates; cross-worktree resource mutex where parallel agents
  share a machine (see M12).

## Port status (Phase 2 remainder)

| Source (docomply `develop`) | Becomes |
|-----------------------------|---------|
| `lefthook.yml` (shape) | `templates/lefthook.yml` + `mappings.md` (husky / pre-commit equivalents) |
| `scripts/check-*` + paired `test-*` convention | `reference/grep-gate/` (framework skeleton: one example gate + self-test + fixtures) |
| `.github/workflows/pr-quality-gates.yml` (shape) | `templates/ci-pr-gates.yml` (GitHub Actions) + GitLab mapping note |
| `docs/development/suppression-token-registry.md` (C7) | `templates/suppression-registry.md` |
| Commit-msg review-marker gate | `reference/` script + notes |

Still to write: `mappings.md`, `maturity.yaml`, and groundwork's own dogfooded
mini-gate set (see ROADMAP Phase 2 remainder item 2).
