# M0 — Per-ecosystem mappings

Where each instruction layer (see the module [README](README.md)) lives in
each major agent runtime, and how the universal-file + tool-delta-pointer
pattern maps onto it. Vendor conventions move fast — the table below is
current as of 2026-07; verify against each vendor's docs before relying on
a detail.

## Layer → location per runtime

| Layer | Claude Code | OpenAI Codex | Cursor | GitHub Copilot |
|-------|-------------|--------------|--------|----------------|
| Universal instruction file | `CLAUDE.md` is what's read natively — make it a pointer to `AGENTS.md` (see below) | `AGENTS.md` (native; the format's origin) | `AGENTS.md` (supported in recent versions) plus `.cursor/rules/` | `.github/copilot-instructions.md` — make it a pointer; the coding agent also reads `AGENTS.md` |
| Tool-specific delta | `CLAUDE.md` (delta + pointer) | usually none needed — reads the universal file directly | `.cursor/rules/` entry with `alwaysApply: true` (delta + pointer); legacy `.cursorrules` is deprecated | `.github/copilot-instructions.md` (delta + pointer) |
| Per-directory files ("closest file wins") | nested `CLAUDE.md` / `AGENTS.md` files | nested `AGENTS.md` files | nested `.cursor/rules/` directories; nested `AGENTS.md` | nested `AGENTS.md` (coding agent) |
| Conditional rules (path-scoped) | `.claude/rules/*.md` with `paths:` frontmatter (no `paths:` ⇒ always-loaded) — see [templates/rules-README.md](templates/rules-README.md) | no native equivalent — state scoped rules in the relevant nested `AGENTS.md` instead | `.cursor/rules/*.mdc` with `globs:` frontmatter (`alwaysApply: true` ⇒ always-loaded) | `.github/instructions/*.instructions.md` with `applyTo:` frontmatter |
| Skills (on-demand procedures) | `.claude/skills/<name>/SKILL.md`, invoked as `/<name>` | `.agents/skills/<name>/SKILL.md` (scanned walking up to repo root; follows symlinks) | no direct equivalent — `.cursor/commands/` covers reusable prompts | `.github/prompts/*.prompt.md` |
| Glossary | plain file (`GLOSSARY.md` / `CONTEXT.md`) linked from the universal file — same in every runtime; Claude Code can additionally auto-load a reminder rule scoped to source/docs paths | same | same | same |
| Dispositions / HITL registry | plain docs linked from the universal file — runtime-independent | same | same | same |

## The universal-file + pointer pattern

The invariant is one source of truth regardless of which file each runtime
happens to read:

1. Write everything once in `AGENTS.md` (see
   [templates/AGENTS-skeleton.md](templates/AGENTS-skeleton.md)).
2. For each runtime that reads a *different* file natively, make that file
   a **delta + pointer**: only runtime-specific content (its MCP config,
   its slash-command notes), opening with "For universal standards, see
   `/AGENTS.md`". Never copy a rule into a delta file — a copy is a fork
   waiting to drift.
3. Where a runtime supports `AGENTS.md` directly (Codex, Cursor, Copilot
   coding agent), the delta file may not be needed at all.

A minimal delta file is one line. If a delta file grows a section that
isn't runtime-specific, move it to `AGENTS.md` and leave a pointer.

## Cross-runtime skill discovery (the symlink mirror)

Skills — packaged, named procedures an agent can invoke (see the
[glossary](../../GLOSSARY.md)) — are the one layer where runtimes scan
*different directories* for the *same kind of content*, so a pointer line
doesn't work — the runtime
needs real files in its scan path. The portable mechanism:

- Author skills once in a canonical directory (`.claude/skills/`).
- Maintain the other runtime's directory (`.agents/skills/`) as a
  **gitignored symlink farm** pointing back at the canonical one,
  regenerated on every dependency install and drift-checked from a
  pre-push hook.
- Script, usage and recipe (in its header comment):
  [reference/sync-skills-mirror.ts](reference/sync-skills-mirror.ts). Run it
  with no argument to create, repair and prune the links; `--check` only
  reports drift and exits 1. `CANONICAL_DIR` and `MIRROR_DIR` override the two
  directories.

Fallback for runtimes with no skill discovery at all: reference the skill
by path in the instruction file ("read `.claude/skills/<name>/SKILL.md`
and follow it") — any tool that can read files can execute a skill.

The skill mirror command runs under the pinned Bun runtime; see
[tools/README.md](../../tools/README.md) for the source-checkout layout.
Windows requires Developer Mode or permission to create symlinks for this
optional discovery mirror; it never substitutes copies for the canonical skills.

## Model tiers per vendor

The tiers of the [model routing policy](reference/model-routing-policy.md)
are roles; these are the model families that filled them in mid-2026. Verify
against the vendor's current lineup and pricing before relying on them.

| Tier | Anthropic | OpenAI |
|------|-----------|--------|
| **Strategic** | Claude Opus-class | GPT-5-class flagship |
| **Execution** | Claude Sonnet-class | mid-tier GPT |
| **Scout** | Claude Haiku-class | `*-mini` models |
