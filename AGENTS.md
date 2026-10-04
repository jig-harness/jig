# Groundwork Agent Instructions

Context for AI coding agents working **on the groundwork repo itself**.
Compatible with Claude Code, Codex, Cursor, and others.

## What this repo is

Groundwork extracts the delivery practices of a mature AI-native codebase (the
docomply monorepo — the private "reference implementation") into a
vendor-agnostic, tech-stack-flexible, modular template. Its uses:
greenfield template, brownfield upgrade path, **runnable auditor** that scores
a target repo and produces actionable recommendations, and **shared runnable
tooling** — the agent skills and development tools (PR review loops, issue
pickup, workspace management, gates) that repositories consume as a pinned
release instead of copying.

The placement rule for that tooling: a generic mechanism lives here; an
organization's values (tracker team and labels, review bots, gate commands,
host names) stay in that organization's own repositories and reach the tooling
as configuration; product-bound code never comes here. The rules in this file
are operative as written. The decision that adopted them is background, not a
source this file defers to: docomply's
[engineering-standards decision 0003](https://github.com/docomply/engineering-standards/blob/main/docs/decisions/0003-groundwork-hosts-generic-agent-tooling.md).

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
  stack over asking for configuration. This governs the doctrine. Runnable
  tooling may be bound to a named tool (Linear, GitHub, Herdr), provided the
  binding sits behind an interface and a second implementation can be added
  without touching callers; build the second one when a consumer needs it,
  not before.
- **Values vs mechanisms.** Reference material ported from docomply must be
  split: repo-agnostic mechanism into `reference/`, docomply-specific values
  replaced by placeholders or `examples/`. Where docomply hasn't made that
  split, make it during porting.
- **IP scrub.** Never import docomply domain content: scenario-matching /
  interpolation mechanisms, tier names, customer data, or anything adjacent to
  its invention disclosure. When porting a docomply file, strip product-domain
  examples and replace with neutral ones. When in doubt, leave it out and note
  the gap.
- **No issue-tracker references.** Content here carries no reference to the
  reference implementation's issue tracker (`DOC-NNNN` keys or links), in
  documents and in code alike. Rationale must stand on its own: in the module
  documentation, or in a comment at the code whose shape needs explaining.
  When moving code in, resolve every such reference: restate the rationale it
  pointed to where the shape is non-obvious, and drop it where the code or
  documentation already makes the reason evident. Enforced by
  `scripts/check-no-tracker-refs.ts`; the key patterns live in
  `scripts/tracker-key-patterns.txt`.
- **De-scarring.** Final documents carry no review-finding traces, reviewer
  dialogue, or "addressed/fixed" annotations — that history lives in PRs and
  issues. A light version-history section is fine.
- **Don't port the unproven; move, never copy.** Dark-by-default dials,
  unvalidated eval fixtures, and aspirational hooks from the reference
  implementation stay out until validated there — note them as "future" in the
  module README instead. Active use shows that tooling is needed, not that
  every part of it is validated: a moved tool brings its own tests, and any
  part of it that is dark by default or unvalidated still stays out under the
  rule above. Port it by moving the operated source here and deleting the
  reference implementation's copy in the same rollout, never by rewriting a
  parallel copy. A rewritten copy becomes a fork the moment the original takes
  its next fix.
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
  consumer needs is moved, vendored or rewritten here, and docomply-specific
  values arrive as configuration from the consumer.

## Ways of working in this repo

- Conventional Commits (`feat:`, `docs:`, `chore:`, …). Work on feature
  branches + PRs once the kernel phase ends; during bootstrap, small direct
  commits to `main` are acceptable.
- **Toolchain.** Runnable tooling and gates are written in Bun + TypeScript:
  Bun runs natively on macOS, Linux and Windows, where Bash runs only through
  a compatibility layer and its standard utilities behave differently on macOS
  and Linux. Bun is this repository's toolchain, not a requirement on target repositories — tooling a
  non-JavaScript repository runs ships as a standalone executable or is pinned
  through mise. The repository and module gates run natively under the pinned
  Bun runtime.
- Quality gates (dogfooded M1, tiny by design) — run all with one command:
  `bun run gates`. The set, in order: format, lint, types, gate self-tests,
  build, Markdown links resolve, blank line before tables, terms of art defined in the glossary
  (acronym proxy; escape hatch: `scripts/glossary-allowlist.txt`), no
  issue-tracker references. CI runs
  the same command on every PR (`.github/workflows/gates.yml`). Scope differs
  per gate, and each check script's header comment states exactly what it
  skips and why: the Markdown gates leave vendored material (`seeds/`,
  `docs/`), `templates/` and test `fixtures/` out, while the issue-tracker
  gate covers everything, vendored material and templates included, except
  test `fixtures/` and its own pattern file.
- HITL (human-in-the-loop) decisions: publishing/visibility, license, deleting
  seed material, and anything touching the IP scrub boundary — flag, don't act.
