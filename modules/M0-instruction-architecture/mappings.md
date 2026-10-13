# M0 — Per-ecosystem mappings

Where each instruction layer (see the module [README](README.md)) lives in
each major agent runtime, and how the universal-file + tool-delta pattern
maps onto it. Vendor conventions move fast: the table below is current as of
2026-07, and the Claude Code and Codex loading rows as of 2026-10. Before you
rely on a detail, check it the way [What each runtime loads](#what-each-runtime-loads)
describes; a vendor's docs page is not enough.

## Layer → location per runtime

| Layer | Claude Code | OpenAI Codex | Cursor | GitHub Copilot |
|-------|-------------|--------------|--------|----------------|
| Universal instruction file | `CLAUDE.md` is what's read natively — make it import `AGENTS.md` with an `@AGENTS.md` line (see below) | `AGENTS.md` (native; the format's origin) | `AGENTS.md` (supported in recent versions) plus `.cursor/rules/` | `.github/copilot-instructions.md` — make it a pointer; the coding agent also reads `AGENTS.md` |
| Tool-specific delta | `CLAUDE.md` (delta + `@AGENTS.md` import) | usually none needed — reads the universal file directly | `.cursor/rules/` entry with `alwaysApply: true` (delta + pointer); legacy `.cursorrules` is deprecated | `.github/copilot-instructions.md` (delta + pointer) |
| Per-directory files (added to the parent's, not replacing them) | nested `CLAUDE.md`, read when a file under it is read; a nested `AGENTS.md` by default only in a project with no `CLAUDE.md` of its own (otherwise only with a user-level setting), so beside a root `CLAUDE.md` pair it with a nested `CLAUDE.md` that imports it | nested `AGENTS.md` files along the path; an `AGENTS.override.md` in a directory is read *instead of* that directory's `AGENTS.md` | nested `.cursor/rules/` directories; nested `AGENTS.md` | nested `AGENTS.md` (coding agent) |
| Conditional rules (path-scoped) | `.claude/rules/*.md` with `paths:` frontmatter (no `paths:` ⇒ always-loaded) — see [templates/rules-README.md](templates/rules-README.md) | no native equivalent — state scoped rules in the relevant nested `AGENTS.md` instead | `.cursor/rules/*.mdc` with `globs:` frontmatter (`alwaysApply: true` ⇒ always-loaded) | `.github/instructions/*.instructions.md` with `applyTo:` frontmatter |
| Skills (on-demand procedures) | `.claude/skills/<name>/SKILL.md`, invoked as `/<name>` | `.agents/skills/<name>/SKILL.md` (scanned walking up to repo root; follows symlinks) | no direct equivalent — `.cursor/commands/` covers reusable prompts | `.github/prompts/*.prompt.md` |
| Glossary | plain file (`GLOSSARY.md` / `CONTEXT.md`) linked from the universal file — same in every runtime; Claude Code can additionally auto-load a reminder rule scoped to source/docs paths | same | same | same |
| Dispositions / HITL registry | plain docs linked from the universal file — runtime-independent | same | same | same |

## What each runtime loads

A file a runtime does not load does not instruct it, however clearly another
file points at it. What each runtime loads is vendor behaviour that changes
without notice, so it is something to observe, not to assume. These were
observed in 2026-10:

- **Claude Code** reads `CLAUDE.md`. A nested `CLAUDE.md` loads when a file
  under its directory is read, and is *added* to the root one. Which
  `AGENTS.md` files it reads depends on the built-in `agents-md` setting
  `instructionFiles`. Under the default, `claude-md-or-agents-md`, a project
  with no `CLAUDE.md` (or `.claude/CLAUDE.md`, or `CLAUDE.local.md`) in any
  directory from the root down to the working directory gets its `AGENTS.md`
  files instead, loaded where a `CLAUDE.md` would be: the ones on that path at
  the start, and a nested one when a file under its directory is read, unless
  a `CLAUDE.md` in that directory claims it. A project with such a
  `CLAUDE.md` gets no `AGENTS.md` at all by default; a root `@AGENTS.md`
  import loads the root one, and a nested one loads only when the setting is
  `claude-md-and-agents-md`. The setting is read only from user, managed or
  command-line settings: a repository cannot commit it, and a person can
  switch the built-in off. Rules in
  `.claude/rules/` without `paths:` load at session start; with `paths:`, when
  a matching file is read.
- **OpenAI Codex** reads `AGENTS.md` from the root down to the working
  directory. In each directory an `AGENTS.override.md` is read *instead of*
  that directory's `AGENTS.md`. Its documentation says nearer files override
  earlier guidance because they come later in the combined prompt. By default
  it keeps only the first 32,768 bytes of the whole chain and drops the rest
  without a warning; `project_doc_max_bytes` in its configuration sets that
  budget, so check the value each consumer actually runs with.
- **pi** (checked against its loader at version 1.2.0) reads one file per
  directory, from the working directory up through its parents plus its own
  agent directory, and none below the working directory. In each directory it
  takes the first regular file that exists, in this order:
  `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`.
  So an `AGENTS.override.md` replaces every other there, and any `AGENTS`
  file wins over any `CLAUDE` file. On a case-insensitive file system (the
  macOS and Windows defaults) the two spellings of one name are the same file.

Consequences:

- **An import is not a pointer.** "See `AGENTS.md`" is text the model may or
  may not act on. An `@AGENTS.md` import puts the file in context. Every rule
  that must bind a runtime reaches it by a path someone has watched load.
- **Never rely on "closest file wins".** The runtimes add nested files to
  the parent's instructions instead of replacing them. Codex lets a nearer
  file override by placing it later; Claude Code states no precedence. A rule
  that holds only because one runtime orders the files a certain way breaks
  in the next one, so a nested file extends its parent, and a contradiction
  between them is a bug to fix, not a tie for the runtime to break.

To check again: start a fresh session, note which instruction files are in
context before any file is opened, then read one file under a directory that
has its own instruction file and note what arrives. Record the date and the
runtime version with what you saw.

## The universal-file + delta pattern

The invariant is one source of truth regardless of which file each runtime
happens to read:

1. Write everything once in `AGENTS.md` (see
   [templates/AGENTS-skeleton.md](templates/AGENTS-skeleton.md)).
2. For each runtime that reads a *different* file natively, make that file
   a **delta**: only runtime-specific content (its MCP config, its
   slash-command notes), plus the line that brings in the universal file. Use
   the runtime's import where it has one (Claude Code: `@AGENTS.md`), and a
   pointer line ("For universal standards, see `/AGENTS.md`") only where it
   has none. Never copy a rule into a delta file — a copy is a fork waiting
   to drift.
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
