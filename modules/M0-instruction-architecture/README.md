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
> bring the universal file in by an import or the runtime's native read;
> conditionally relevant rules load only in their scope; domain
> vocabulary is defined once in a glossary; and behavioral defaults
> (dispositions) are written down with the conditions under which they flip.

Further invariants decide whether those instructions reach the agent at all:

- **Delivery is observed.** Every rule that must bind a runtime reaches that
  runtime's context by a [load path](../../GLOSSARY.md) someone has watched work: an import, or a
  file the runtime reads natively, never a line of text pointing somewhere
  else. What each runtime loads is recorded once, with the date it was
  observed and a procedure to check it again
  ([mappings.md](mappings.md#what-each-runtime-loads)). Which file wins when
  two disagree is an authoring convention written down, never runtime
  behaviour assumed. Two runtimes have the same rules when each one's context
  holds them, not when their files mirror each other.
- **Always-loaded context is a budget.** The text a runtime loads before the
  agent acts, the [always-loaded context](../../GLOSSARY.md), is measured
  against the smallest budget of every runtime and reviewer that reads it.
  It includes the chained instruction files, rules with no path scope, the
  names and descriptions of every skill and agent (their
  [discovery metadata](../../GLOSSARY.md)), and the instructions [MCP](../../GLOSSARY.md) servers
  send. [CI](../../GLOSSARY.md) checks the cumulative instruction chain and the per-item and
  aggregate discovery budgets before dependencies are installed. Text past a
  consumer's budget counts as not delivered to that consumer, however
  complete the file looks.

## The layers

1. **Universal instruction file** (`AGENTS.md` at repo root) — project
   overview, critical guardrails, quality gates, ways of working. Vendor-
   neutral so every agent runtime reads the same truth.
2. **Tool-specific delta** (`CLAUDE.md`, `.cursorrules`, …) — only what is
   specific to that runtime; everything else comes from the universal file,
   through the runtime's import or its native read of `AGENTS.md`. Where a
   runtime has neither, a pointer line is not delivery: generate the delta it
   needs from the universal file, with a drift check, or record the gap in the load model
   ([mappings.md](mappings.md#what-each-runtime-loads)).
3. **Per-directory files** — nested instruction files scoped to an app or
   package. Runtimes add them to the parent's instructions rather than
   replacing them; some let a nearer file override by placing it later, others
   state no precedence at all. So the authoring rule does not lean on either:
   a nested file extends its parent, and a contradiction between them is a
   bug. Which files each runtime actually loads is observed, not assumed
   ([mappings.md](mappings.md#what-each-runtime-loads)).
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
- **Standard** — full layering: tool deltas that bring the universal file in
  by an import or a native read, per-directory files where conventions differ,
  conditional rules with documented loading semantics, dispositions with flip
  conditions. What each runtime loads is recorded with dated evidence and a
  procedure to check it again.
- **Strict** — instruction files carry freshness checks (M2): countable facts
  are CI-verified against reality, referenced paths are checked to exist, and
  the instruction set has a named owner and review cadence. CI fails a change
  that puts the always-loaded context over its smallest consumer's budget,
  before dependencies are installed.

## Adoption steps

1. Copy [`templates/AGENTS-skeleton.md`](templates/AGENTS-skeleton.md) to the
   repository root as `AGENTS.md`, fill in the quality gates and the
   guardrails, and keep it near 150 lines. Copy
   [`templates/GLOSSARY-skeleton.md`](templates/GLOSSARY-skeleton.md) to
   `GLOSSARY.md` and link it from `AGENTS.md`. This is **Lite**.
2. Turn every runtime-specific file into a delta that imports the universal
   file or relies on the runtime's native read of `AGENTS.md`; where a runtime
   has neither, generate the delta or record the gap in the load model (where
   each runtime reads from: [`mappings.md`](mappings.md)); add nested instruction
   files where a directory's conventions differ; if you use conditional rules,
   copy [`templates/rules-README.md`](templates/rules-README.md) into the rules
   directory; write your dispositions from
   [`templates/dispositions.md`](templates/dispositions.md), each with its flip
   condition. Record what each runtime you use loads, with the date and a way
   to check it again: start from [What each runtime loads](mappings.md#what-each-runtime-loads)
   and observe your own repository. This is **Standard**.
3. Check the instruction files mechanically in CI: stated counts and
   referenced paths with [M2](../M2-generated-artifact-freshness/)'s
   [`prose-facts`](../M2-generated-artifact-freshness/reference/prose-facts/)
   checks, and the always-loaded context with the
   [context-budget checks](reference/context-budget/README.md), in a step
   before dependencies are installed
   ([recipe](mappings.md#ci-recipe-before-dependencies-install)). Name an
   owner for the instruction set and a review cadence. This is **Strict**.

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
- [`reference/context-budget/`](reference/context-budget/README.md) — two
  checks of the always-loaded context: every root-to-directory instruction
  chain against the smallest consumer's byte budget, and skill and agent
  descriptions against their per-item caps and the aggregate skill listing.
  Built-ins only, with self-tests and fixtures beside them.
- [`mappings.md`](mappings.md) (Claude Code, Codex, Cursor and Copilot file
  conventions, what each runtime loads, the budgets per consumer with their
  dates, and the CI recipe) and the module's
  [maturity criteria](../../plugin/skills/audit/criteria/M0-instruction-architecture.yaml).

Jig's own [`AGENTS.md`](../../AGENTS.md), the `CLAUDE.md` files that
import it, and the nested `AGENTS.md` files, each with a `CLAUDE.md` beside it
that imports it, are a working instance of this module; `bun run gates` and
CI run the context-budget checks over Jig itself, with the soft description
target enforced for the plugin's skills, since every repository that
installs the plugin pays for them.

What the context-budget checks leave out, and why: MCP server instruction
blocks, skills from a person's own setup or another plugin, and a person's
own instruction files are part of the always-loaded surface, but no
repository file shows them, so they are measured in a running session
instead. Whether a runtime received a rule at all is the observation in
[mappings.md](mappings.md#what-each-runtime-loads); the checks measure what
the repository asks each runtime to load, not what arrived.

Future: a generator for a per-agent model roster (the routing policy describes
the pattern; the generate-and-check mechanism belongs with
[M2](../M2-generated-artifact-freshness/)), and a pull-request review step that
reads rule frontmatter to pick the rules relevant to a diff (it belongs with
[M7](../M7-pr-lifecycle-review/)'s review harness).
