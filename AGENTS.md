# Groundwork Agent Instructions

Context for AI coding agents working **on the groundwork repo itself**.
Compatible with Claude Code, Codex, Cursor, and others.

## What this repo is

Groundwork extracts the delivery practices of a mature AI-native codebase (the
docomply monorepo — the private "reference implementation") into a
vendor-agnostic, tech-stack-flexible, modular template. It serves three uses:
greenfield template, brownfield upgrade path, and **runnable auditor** that
scores a target repo and produces actionable recommendations.

Read in this order when starting a session here:

1. [ROADMAP.md](ROADMAP.md) — what is done, what is next (the continuation anchor).
2. [docs/founding-charter-2026-07-18.md](docs/founding-charter-2026-07-18.md) —
   the founding analysis: practice inventory, module map, extraction blueprint.
3. The module(s) you are working on under [modules/](modules/).

## Writing conventions (MANDATORY)

- **Plain language first.** Groundwork must be accessible to readers unfamiliar
  with any of these techniques. Expand jargon on first use per document and
  link it to [GLOSSARY.md](GLOSSARY.md). When you introduce a new term of art,
  add it to the glossary in the same commit. Every module README opens with a
  plain-language "what problem this solves / what it looks like without it"
  paragraph before any mechanism detail.
- **Invariant before tools.** State each practice as a tool-independent
  invariant, then map concrete implementations per ecosystem in the module's
  `mappings.md` (agent runtimes; issue trackers; hook managers; CI providers;
  review bots). Derive-don't-declare where possible: prefer detecting a repo's
  stack over asking for configuration.
- **Values vs mechanisms.** Reference material ported from docomply must be
  split: repo-agnostic mechanism into `reference/`, docomply-specific values
  replaced by placeholders or `examples/`. Where docomply hasn't made that
  split, make it during porting.
- **IP scrub.** Never import docomply domain content: scenario-matching /
  interpolation mechanisms, tier names, customer data, or anything adjacent to
  its invention disclosure. When porting a docomply file, strip product-domain
  examples and replace with neutral ones. When in doubt, leave it out and note
  the gap.
- **De-scarring.** Final documents carry no review-finding traces, reviewer
  dialogue, or "addressed/fixed" annotations — that history lives in PRs and
  issues. A light version-history section is fine.
- **Don't port the unproven.** Dark-by-default dials, unvalidated eval
  fixtures, and aspirational hooks from the reference implementation stay out
  until validated there. Note them as "future" in the module README instead.
- Markdown: blank line before every table (many renderers break otherwise).

## Module contract

Every module directory `modules/M<n>-<name>/` converges on:

```
README.md      # plain-language opener, invariant, maturity levels, adoption steps, port status
templates/     # copyable skeletons (AGENTS.md skeleton, PRD template, …)
reference/     # portable scripts / workflow YAML / schema files
mappings.md    # per-ecosystem tool mapping table
maturity.yaml  # machine-evaluable criteria the auditor scores against
```

A kernel-stage module may have only `README.md` — the README's **Port status**
section says what is still missing. Keep `maturity.yaml` criteria phrased as
observable repo facts (file exists, CI job present, hook configured), scored on
the enforcement ladder: *absent → convention-only → mechanically enforced*.

## Relationship to docomply (the reference implementation)

- Docomply is **instance #1**, not upstream: groundwork states the general
  pattern; docomply holds one concrete, battle-tested implementation.
- **Backflow**: when the reference implementation learns something (a new lens,
  gate, or corrected design), evaluate it for porting. Port the *corrected*
  design, not the first attempt — e.g., derivable-fact freshness landed there
  as "CI-check without committing the derived file" after materialized copies
  proved a merge-conflict liability (prefer: drop > CI-check > commit).
- Port sources are pinned per module in each module README and in
  [ROADMAP.md](ROADMAP.md). All C1–C9 codification artifacts live on docomply
  `develop` (paths listed in ROADMAP.md § Port sources).
- Groundwork must never *require* docomply access to be useful: everything a
  consumer needs gets vendored or rewritten here.

## Ways of working in this repo

- Conventional Commits (`feat:`, `docs:`, `chore:`, …). Work on feature
  branches + PRs once the kernel phase ends; during bootstrap, small direct
  commits to `main` are acceptable.
- There are no CI gates here yet (M1 will introduce groundwork's own, dogfooded
  set — see ROADMAP Phase 2 remainder). Until then: self-check that links
  resolve and tables render.
- HITL (human-in-the-loop) decisions: publishing/visibility, license, deleting
  seed material, and anything touching the IP scrub boundary — flag, don't act.
