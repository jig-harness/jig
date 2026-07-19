# Glossary

Plain-language definitions of every term of art used in groundwork. Terms are
capitalized as commonly written; cross-references are *italicized*.

## Core ideas

- **AI-native delivery** — building and maintaining software with AI coding
  agents as first-class participants: the repo is organized so agents can find
  the rules, run the checks, and improve the process — not just emit code.
- **Scaffolding** — everything in a repo that exists to guide agents (and
  humans): instruction files, *skills*, *rules*, glossaries, checkers. Not the
  product code itself.
- **SSoT (single source of truth)** — the one authoritative place a fact or
  rule is defined. Everything else *points* to it or is *generated* from it,
  so copies can't quietly disagree.
- **Drift** — the gap that grows when two copies of the same fact evolve
  independently (a doc says one thing, the code does another). Groundwork's
  recurring answer: make one copy the *SSoT* and gate or generate the rest.
- **Module** — groundwork's unit of adoption: one practice area (e.g.,
  "generated-artifact freshness") packaged with its invariant, maturity
  levels, templates, and reference code. Modules adopt independently.
- **Maturity level** — how deeply a module is adopted: **Lite** (minimum
  useful), **Standard** (production teams), **Strict** (regulated/compliance
  posture). Brownfield projects climb one level at a time.
- **Profile** — a recommended composition of modules and maturity levels for a
  project shape: Solo/Lite, Team/Standard, Regulated/Strict.
- **Invariant** — the tool-independent statement of a practice ("every
  committed generated file has a drift check"), as opposed to any particular
  tool that implements it.
- **Vendoring** — copying external material into a repo so it remains
  available and stable regardless of the original's location or lifetime.

## Enforcement

- **Quality gate** — a check that must pass before work proceeds (formatting,
  linting, type checks, tests, build).
- **Enforcement ladder** — the ordered places a rule can live: written
  convention → editor/local script → *git hook* → *CI* → mandatory review
  step. Each rung is harder to bypass. Groundwork treats "which rung is this
  rule on, and what promotes it?" as a first-class question — and the rung is
  what the *auditor* scores.
- **Convention-only** — a rule that exists only as prose or habit, with no
  mechanical check. A tracked state, not a resting place.
- **Git hook** — a script that runs automatically at a git event
  (pre-commit, pre-push, commit-msg). Managed by tools like lefthook, husky,
  or pre-commit.
- **CI (continuous integration)** — the service that runs checks on every
  push/PR (GitHub Actions, GitLab CI, …). In groundwork's model, CI is the
  *authority*: local hooks are conveniences that can be bypassed; CI closes
  the hole.
- **Grep gate** — a deliberately simple check that searches the codebase for a
  forbidden or required pattern. Cheap, fast, and good enough for many rules;
  each ships with a self-test so the gate itself can't silently break.
- **Generated artifact** — a committed file produced by a script from some
  source of truth (an API spec from route definitions, an index from a docs
  tree). Must never be edited by hand.
- **Freshness gate (drift check)** — the check that fails when a *generated
  artifact* no longer matches what its generator would produce — proof the
  committed copy is stale.
- **Suppression token** — a documented inline marker that legitimately
  silences a specific gate at a specific spot, with a justification. A
  registry of them prevents ad-hoc, invisible exceptions.

## Process

- **ADR (architecture decision record)** — a short numbered document capturing
  one significant decision, its context, and its consequences. Append-only
  history: superseded ADRs are marked, not rewritten.
- **PRD (product requirements document)** — the document defining *what* a
  feature does for users and why — deliberately separate from *how* (the
  architecture doc).
- **Draft PR** — a pull request opened in "not ready for review" state so CI
  and bots can run while a human decides when it's worth reviewers' attention.
- **HITL (human-in-the-loop)** — a decision class that must be made by a
  human, never autonomously by an agent (merges, releases, destructive
  operations, scope expansions). Kept in an explicit registry.
- **De-scarring** — cleaning a finished document of review findings,
  corrections, and reviewer dialogue ("scars") so it reads cleanly; the
  history stays in PRs, issues, and git — not in the artifact.
- **Flag label** — an issue-tracker label that *drives process* rather than
  just categorizing (e.g., "has-migration" → a mandatory review gate fires).
- **Worktree** — a git feature giving one repository multiple working
  directories, letting several agents work different branches of the same repo
  in parallel on one machine.
- **Monorepo** — one repository holding many applications/packages, usually
  with a shared task runner and shared quality gates.

## Review & learning

- **Shadow reviewer** — an in-house automated PR reviewer that runs alongside
  commercial review bots in comment-only mode, so its quality can be measured
  against them before it's ever allowed to block anything.
- **Review lens** — one additive, numbered check taught to a reviewer (a
  prompt module or checklist bullet), typically born from a documented miss.
- **Miss→lens flywheel** — the improvement loop: an external reviewer or human
  catches what the automated reviewer missed → the miss is classified, filed,
  and reconstructed as an *eval fixture* → a new *lens* is added → validated →
  measured. Generalizes to any evaluable agent behavior.
- **Eval fixture / corpus** — a pinned historical case (exact commit + expected
  findings) that a reviewer or agent is re-run against, turning past misses
  into a regression test for the process itself.
- **Skill** — a packaged, named procedure an agent can invoke (a review
  checklist, a migration workflow). The unit of codified "how we do this
  here."
- **Rule (conditional rule)** — an instruction file that loads into agent
  context only when files matching its path patterns are being edited — the
  scoped counterpart of an always-loaded instruction file.
- **Scout** — a small, cheap agent (fast model, read-only) sent ahead of
  implementation to gather facts; part of tiered model routing (expensive
  models decide, cheap models explore).
- **Auditor** — groundwork's runnable assessment: parallel surveys of a target
  repo, stack detection, per-module maturity scoring, and a prioritized
  recommendations report. See [audit/](audit/).
- **Backflow** — the standing rule that lessons from a live implementation
  flow back into this template (and vice versa), keeping both honest.
