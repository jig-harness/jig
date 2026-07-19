---
paths:
  - ".claude/rules/**"
---

<!--
  TEMPLATE — copy this file into your repo's conditional-rules directory
  (for Claude Code: .claude/rules/README.md) and adapt the placeholders.
  The frontmatter above MUST stay the first thing in the file (parsers
  ignore it otherwise); it scopes this README to the rules directory
  itself — keep it, adjusting the glob if your rules live elsewhere. See
  the module mappings.md for where the equivalent directory lives in other
  runtimes (Cursor, Copilot) and how their frontmatter keys differ.
-->

# Conditional instruction rules

This directory holds **rules**: short, focused instruction files that the
agent runtime injects into the agent's context. Some load on every session;
others load only when the agent is touching files that match a glob. This
README documents the loading model, the glob semantics, the authoring
conventions, and an inventory of the rules present.

## Loading model

Each `.md` file here is a rule. What decides **when** it loads is the
presence of a `paths:` **key** in its YAML frontmatter — not frontmatter in
general:

| Frontmatter | Load behavior | Use for |
|-------------|---------------|---------|
| **`paths:` key present** | **Path-scoped** — loads only when the current context includes a file whose repo-relative path matches at least one glob. | Rules that only matter for one area (backend, frontend, a specific tool, a package). The default and preferred choice. |
| **No `paths:` key** (no frontmatter at all, or frontmatter without a `paths:` key) | **Always-loaded** — injected into every session regardless of what's being edited. | Only rules that are genuinely universal (apply to *any* change in the repo). Every always-loaded rule spends context budget on every prompt, so keep this set small and cheap. |

Prefer `paths:` scoping. Reach for always-loaded only when a rule truly
applies to every change — and even then, weigh whether it belongs in the
universal instruction file (`AGENTS.md`) instead (see
[Where a rule belongs](#where-a-rule-belongs)).

Authors get this distinction wrong silently unless it is written down: a
rule dropped in without frontmatter becomes a tax on every session, and a
rule with a typo'd glob never loads at all. When in doubt, verify
empirically — start a session without touching any file, note which rules
arrive, then touch a matching file and check the scoped rule appears.

## Glob syntax and semantics

Globs are matched against the **repo-relative path** of files the agent has
in context (files being read or edited), using standard globstar matching:

- `**` matches any number of path segments, including zero —
  `apps/backend/**` matches `apps/backend/src/x.ts` and `apps/backend/index.ts`.
- `*` matches within a single segment — `apps/**/*.tsx` matches any `.tsx`
  under `apps/`.
- `*.md` matches by extension at the root; `**/*.md` matches Markdown
  anywhere in the tree.
- A rule loads if **any one** of its globs matches **any one** file in
  context. Globs within a rule are OR'd, not AND'd.

**YAML quoting.** A glob that *starts* with `*` (e.g. `**/*.md`) must be
quoted — unquoted, YAML parses a leading `*` as an alias reference and
errors. Globs starting with a literal path segment (`apps/backend/**`) may
be left unquoted. When in doubt, quote. This is a YAML requirement, not a
loader one.

## Authoring conventions

- **One concern per rule.** A rule is a single, nameable policy. Bundling
  unrelated policies defeats path-scoping — a broad rule loads for edits
  that only touch one of its concerns.
- **Scope tightly.** Give every rule the narrowest `paths:` that still
  covers where it applies. A backend-only rule scoped to `apps/**` wastes
  context on every frontend edit.
- **Token-budget discipline.** Rules are prompt overhead, paid on every
  matching edit. State the rule, the rationale in a line or two, and a
  pointer to the full doc for depth. Link, don't inline.
- **Naming.** `kebab-case.md`, named for the concern
  (`multi-tenant-isolation.md`), not for the area. The filename is the
  rule's identity in cross-references.
- **Frontmatter is `paths:`-only.** The loader reads only `paths:`. Extra
  keys are inert noise — and if other tooling (e.g. a review harness) parses
  the same frontmatter, a nonstandard shape can make it drop the rule.
  Write `paths:` as a YAML list of quoted globs, nothing else.

## Where a rule belongs

| Put it in… | When |
|------------|------|
| **A rule file here** | The instruction is conditional on *what code area is being touched*, and is a standing policy an agent must not violate. Path-scoping is the whole point. |
| **The universal instruction file** (`AGENTS.md`) | The instruction is universal (applies to every change) or is workflow/orientation an agent needs up front. An always-loaded rule with no `paths:` is usually a sign the content belongs there instead. |
| **A skill** | The content is a *procedure the agent invokes on demand* (a multi-step workflow, a review gate, a generator), not a constraint that should always be in scope. Rules are passive guardrails; skills are active tools. |

## Rule inventory

Each rule file's `paths:` frontmatter is the source of truth; the Scope
column is a hand-maintained summary of it. When you add, remove, or
re-scope a rule, update its row in the same commit — if in doubt, the
frontmatter wins. Don't state a running count of rows (it goes stale the
moment a rule is added).

| Rule | Concern | Scope |
|------|---------|-------|
| `<rule-name>.md` | <one-line policy summary> | `<glob>` or **Always-loaded** |

## Why this README has `paths:` frontmatter

This file is itself a `.md` in the rules directory. Left without
frontmatter it would be treated as an **always-loaded rule** and injected
into every session — the opposite of what an authoring guide should do.
Scoping it to the rules directory keeps it out of default context and
surfaces it precisely when someone is editing a rule. Do not remove the
frontmatter above.
