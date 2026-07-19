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

## Port status (Phase 2 remainder)

Port and genericize from the reference implementation (docomply `develop`):

| Source | Becomes |
|--------|---------|
| `AGENTS.md` (structure, not content) | `templates/AGENTS-skeleton.md` |
| `.claude/rules/README.md` (C8) | `templates/rules-README.md` + loading-semantics doc |
| `CONTEXT.md` + glossary rule | `templates/GLOSSARY-skeleton.md` + authoring notes |
| Dispositions (systematic default, BWC-deferred, minimalism ladder) | `templates/dispositions.md` |
| `docs/development/ai-tools/model-routing-policy.md` (C9) | `reference/model-routing-policy.md` (tiered model economics) |
| `docs/development/hitl-decision-registry.md` (C6) | `templates/hitl-registry.md` (shared with M7) |
| Cross-runtime skill discovery (symlink mirror + sync script) | `reference/` script + `mappings.md` entry |

Still to write: `mappings.md` (Claude Code / Codex / Cursor / Copilot file
conventions), `maturity.yaml`.
