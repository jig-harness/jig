# M0 — Instruction architecture

**What problem this solves.** AI agents (and new contributors) act on whatever
instructions they find. Without deliberate structure, instructions end up
duplicated across files that drift apart, bloated into contexts that bury the
important rules, or missing exactly where the work happens — and parallel
agents invent their own vocabulary for the same concepts, producing code and
docs that disagree with each other. This module is the layered instruction
system that keeps agent guidance findable, small, scoped, and single-sourced.

## Invariant

> Agent instructions form a layered hierarchy with one universal source of
> truth. Tool-specific and directory-specific files carry only their delta and
> point back; conditionally relevant rules load only in their scope; domain
> vocabulary is defined once in a glossary; and behavioral defaults
> (dispositions) are written down with the conditions under which they flip.

## The layers

1. **Universal instruction file** (`AGENTS.md` at repo root) — project
   overview, critical guardrails, quality gates, ways of working. Vendor-
   neutral so every agent runtime reads the same truth.
2. **Tool-specific delta** (`CLAUDE.md`, `.cursorrules`, …) — only what is
   specific to that runtime; everything else is a pointer to the universal
   file.
3. **Per-directory files** — nested instruction files scoped to an app or
   package; "closest file wins" for local conventions.
4. **Conditional rules** — rule files with path patterns in their frontmatter,
   loaded into agent context only when matching files are edited. A rule
   without patterns is always loaded — that distinction must be documented in
   the rules directory's README, or authors will get it wrong silently.
5. **Glossary** (`CONTEXT.md` / `GLOSSARY.md`) — one short page of canonical
   domain terms with explicit "avoid" aliases. The cheapest known fix for
   parallel-agent vocabulary drift.
6. **Dispositions** — written behavioral defaults: the systematic-over-
   improvised bias, minimalism ladders, and lifecycle-stage stances (e.g.,
   "backward compatibility deferred until first real customer data — here is
   the flip condition"). A disposition without a flip condition becomes dogma.

## Maturity levels

- **Lite** — one universal instruction file (≤ ~150 lines) + a glossary.
  Nothing else. Criteria: file exists at root; gates and guardrails listed;
  glossary exists.
- **Standard** — full layering: tool deltas as pointers, per-directory files
  where conventions differ, conditional rules with documented loading
  semantics, dispositions with flip conditions.
- **Strict** — instruction files carry freshness checks (M2): countable facts
  are CI-verified against reality, referenced paths are checked to exist, and
  the instruction set has a named owner and review cadence.

## Adoption steps

1. Copy [`templates/AGENTS-skeleton.md`](templates/AGENTS-skeleton.md) to the
   repository root as `AGENTS.md`, fill in the quality gates and the
   guardrails, and keep it near 150 lines. Copy
   [`templates/GLOSSARY-skeleton.md`](templates/GLOSSARY-skeleton.md) to
   `GLOSSARY.md` and link it from `AGENTS.md`. This is **Lite**.
2. Turn every runtime-specific file into a delta plus a pointer (where each
   runtime reads from: [`mappings.md`](mappings.md)); add nested instruction
   files where a directory's conventions differ; if you use conditional rules,
   copy [`templates/rules-README.md`](templates/rules-README.md) into the rules
   directory; write your dispositions from
   [`templates/dispositions.md`](templates/dispositions.md), each with its flip
   condition. This is **Standard**.
3. Check the instruction files mechanically in CI: stated counts and
   referenced paths with [M2](../M2-generated-artifact-freshness/)'s
   [`prose-facts`](../M2-generated-artifact-freshness/reference/prose-facts/)
   checks. Name an owner for the instruction set and a review cadence. This is
   **Strict**.

## Status

What this module provides:

- [`templates/AGENTS-skeleton.md`](templates/AGENTS-skeleton.md) — the
  universal instruction file's structure: overview, guardrails, gates, git
  workflow, per-directory table.
- [`templates/GLOSSARY-skeleton.md`](templates/GLOSSARY-skeleton.md) — a
  one-page domain glossary with _Avoid_ aliases; authoring notes in its header
  comment.
- [`templates/rules-README.md`](templates/rules-README.md) — the conditional
  rules directory's README, with the loading semantics written inline.
- [`templates/dispositions.md`](templates/dispositions.md) — the systematic
  default, the minimalism ladder and the deferred-backward-compatibility
  stance, each with its flip condition.
- [`templates/hitl-registry.md`](templates/hitl-registry.md) — the registry of
  decisions that always stay with a human (shared with
  [M7](../M7-pr-lifecycle-review/)).
- [`reference/model-routing-policy.md`](reference/model-routing-policy.md) —
  which model tier handles which work, and why.
- [`reference/sync-skills-mirror.ts`](reference/sync-skills-mirror.ts) — keeps
  a second runtime's skill directory as a symlink mirror of the canonical one;
  `--check` reports drift. Its self-test is in
  [`scripts/freshness.test.ts`](../../scripts/freshness.test.ts); the recipe is
  in [`mappings.md`](mappings.md#cross-runtime-skill-discovery-the-symlink-mirror).
- [`mappings.md`](mappings.md) (Claude Code, Codex, Cursor and Copilot file
  conventions) and the module's [maturity criteria](../../plugin/skills/audit/criteria/M0-instruction-architecture.yaml).

Jig's own [`AGENTS.md`](../../AGENTS.md), `CLAUDE.md` pointer and
nested `AGENTS.md` files are a working instance of this module.

Future: a generator for a per-agent model roster (the routing policy describes
the pattern; the generate-and-check mechanism belongs with
[M2](../M2-generated-artifact-freshness/)), and a pull-request review step that
reads rule frontmatter to pick the rules relevant to a diff (it belongs with
[M7](../M7-pr-lifecycle-review/)'s review harness).
