# M0 — Per-ecosystem mappings

Where each instruction layer (see the module [README](README.md)) lives in
each major agent runtime, and how the universal-file + tool-delta pattern
maps onto it. Vendor conventions move fast: the table below is current as of
2026-07, the Claude Code and Codex loading rows as of 2026-10, and the
budgets carry their own dates. Before you
rely on a detail, check it the way [What each runtime loads](#what-each-runtime-loads)
describes; a vendor's docs page is not enough.

## Layer → location per runtime

| Layer | Claude Code | OpenAI Codex | Cursor | GitHub Copilot |
|-------|-------------|--------------|--------|----------------|
| Universal instruction file | `CLAUDE.md` is what's read natively — make it import `AGENTS.md` with an `@AGENTS.md` line (see below) | `AGENTS.md` (native; the format's origin) | `AGENTS.md` (supported in recent versions) plus `.cursor/rules/` | the coding agent reads `AGENTS.md` natively; `.github/copilot-instructions.md` has no import, so what it must carry is generated from `AGENTS.md` |
| Tool-specific delta | `CLAUDE.md` (delta + `@AGENTS.md` import) | usually none needed — reads the universal file directly | `.cursor/rules/` entry with `alwaysApply: true` (delta only; Cursor reads `AGENTS.md` natively); legacy `.cursorrules` is deprecated | `.github/copilot-instructions.md` (delta only, for the surfaces that do not read `AGENTS.md`) |
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
  budget, so check the value each consumer actually runs with. The hosted
  Codex reviewer applies the default even where the repository configures a
  larger value (observed 2026-09), so for the repository the smallest budget
  is the default whatever it configures.
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
  Precedence is an authoring convention written down, never runtime
  behaviour assumed.
- **Parity is what arrives, not what is mirrored.** Two runtimes have the same
  rules when each one's context holds them, which the check below shows.
  Mirrored files prove only that the files match; a runtime that does not
  load one, or cuts it off at its budget, still misses the rule.

To check again: start a fresh session, note which instruction files are in
context before any file is opened, then read one file under a directory that
has its own instruction file and note what arrives. Record the date and the
runtime version with what you saw.
Ask also where the instruction files end: have the session quote the last
lines of each file it holds, and compare them with the files' real ends. A
file cut short at a budget looks loaded until its tail is asked for.

## Always-loaded context budgets

The always-loaded surface (see the [glossary](../../GLOSSARY.md)) is
everything a runtime puts in context before the agent acts. Each consumer
has its own budget for it, and the repository's surface has to fit the
smallest one, because what runs past a consumer's budget does not reach that
consumer. The budgets, with the date each was checked:

| Consumer | What it bounds | Budget | Past it | Checked |
|----------|----------------|--------|---------|---------|
| Codex | the joined root-to-directory `AGENTS.md` chain | 32,768 bytes by default; `project_doc_max_bytes` changes it | the rest is dropped without a warning | 2026-10 |
| Hosted Codex reviewer | the same chain | 32,768 bytes, whatever the repository configures | dropped without a warning | 2026-09 |
| Claude Code (2.1.x) | the skill listing: each model-invocable skill's name, description and `when_to_use` | about 1% of the [context window](../../GLOSSARY.md): 8,000 characters for a 200,000-[token](../../GLOSSARY.md) window at 4 characters a token | not every entry reaches the listing | 2026-09 |
| Claude Code (2.1.x) | one listing entry's description plus `when_to_use` | 1,536 characters | cut off | 2026-09 |
| Any runtime following the [agent-skills specification](https://agentskills.io/specification) | one skill description | 1,024 characters | the skill fails validation | 2026-09 |

Jig sets a soft target of 512 characters per description, half the hard
limit: room enough to say what the skill does and when to use it, while
every character past that is paid in every session whether the skill runs or
not. Text past a budget fails quietly: a root file past the budget looks
complete to its editors while Codex sees only its first 32,768 bytes.

Where the always-loaded surface lives in each runtime:

| Part | Claude Code | OpenAI Codex | Cursor | GitHub Copilot |
|------|-------------|--------------|--------|----------------|
| Chained instruction files | `CLAUDE.md` with its imports, root to working directory | `AGENTS.md` chain, root to working directory | `AGENTS.md` and `alwaysApply: true` rules | `.github/copilot-instructions.md`; `AGENTS.md` for the coding agent |
| Unscoped rules | `.claude/rules/*.md` without `paths:` | none | `.cursor/rules/*.mdc` with `alwaysApply: true` | `.github/instructions/*.instructions.md` with `applyTo: "**"` |
| Skill and agent discovery metadata | name, description and `when_to_use` of every model-invocable skill; each subagent's name and description | name and description of each skill it scans | none native | prompt files are invoked, not listed |
| [MCP](../../GLOSSARY.md) server instruction blocks | the `instructions` each connected server sends | the servers' `instructions`, where the runtime passes them on | the same | the same |

MCP (Model Context Protocol) server instruction blocks arrive from the
servers a session connects to, which a person's own configuration can add,
so no repository file shows them: measure them in a running session, with
the check in [What each runtime loads](#what-each-runtime-loads).

### CI recipe: before dependencies install

The [context-budget checks](reference/context-budget/README.md) use only
Bun's built-ins, so they run before the dependency install, on every pull
request and with no path filter. Run them from a pinned Jig checkout, or
vendor the folder with the Jig files it imports, keeping their paths
relative to it: `lib/cli.ts` and `lib/files.ts` for the checks, and
`lib/test-helpers/expect-spawn-exit.ts` and `plugin/shared/guarded-git-spawn.ts` as
well to run their self-tests. All four use only Bun's built-ins.

The chain check models Codex's `AGENTS.md` chain. A repository whose
instructions live only in `CLAUDE.md` files measures them the way Codex
would read them by naming that file as a fallback in `.codex/config.toml`:

```toml
project_doc_fallback_filenames = ["CLAUDE.md"]
```

Claude Code's own chain, `CLAUDE.md` and what its imports bring in, is not
measured: it loads by other rules and no byte cut-off is known for it.

```yaml
# GitHub Actions: steps of the job that runs the gate set.
steps:
  - uses: actions/checkout@<full-commit-sha> # v6
  - uses: actions/checkout@<full-commit-sha> # v6
    with:
      repository: <owner/name> # of https://github.com/docomply/jig
      ref: <jig-full-commit-sha>
      path: jig
  - uses: jdx/mise-action@<full-commit-sha> # v3 (installs the pinned Bun)
  - name: Check the always-loaded context budget
    run: |
      bun jig/modules/M0-instruction-architecture/reference/context-budget/check-instruction-chain.ts .
      bun jig/modules/M0-instruction-architecture/reference/context-budget/check-discovery-budget.ts \
        --skills .claude/skills --agents .claude/agents
  - name: Install locked dependencies
    run: <install command>
```

```yaml
# GitLab CI: a job with no install step and no `rules: changes:` filter, in
# an image that has Bun.
context-budget:
  stage: .pre
  image: oven/bun:<version>
  script:
    - git clone https://github.com/docomply/jig.git jig
    - git -C jig checkout <jig-full-commit-sha>
    - bun jig/modules/M0-instruction-architecture/reference/context-budget/check-instruction-chain.ts .
    - bun jig/modules/M0-instruction-architecture/reference/context-budget/check-discovery-budget.ts --skills .claude/skills --agents .claude/agents
```

Name only folders that exist: a missing folder is a usage error. Name every
skill folder a runtime scans (`.claude/skills`, `.agents/skills` when it
holds real files rather than the symlink mirror) and add
`--namespace <plugin>` when the folder ships as a plugin, since the runtime
lists its skills as `<plugin>:<skill>`. A repository that measures its own
plugin and also has skills of its own names those with `--bare-skills <dir>`:
both appear in the same session's listing, so they share one allowance.

## The universal-file + delta pattern

The invariant is one source of truth regardless of which file each runtime
happens to read:

1. Write everything once in `AGENTS.md` (see
   [templates/AGENTS-skeleton.md](templates/AGENTS-skeleton.md)).
2. For each runtime that reads a *different* file natively, make that file
   a **delta**: only runtime-specific content (its MCP config, its
   slash-command notes), plus the line that brings in the universal file
   through the runtime's import (Claude Code: `@AGENTS.md`). A pointer line
   ("For universal standards, see `/AGENTS.md`") is not delivery. Where a
   runtime has no import and no native read of `AGENTS.md`, generate the
   delta from the universal file (with a drift check, as
   [M2](../M2-generated-artifact-freshness/README.md) describes) or record the
   gap in [What each runtime loads](#what-each-runtime-loads). Never copy a
   rule into a delta file by hand — a copy is a fork waiting to drift.
3. Where a runtime supports `AGENTS.md` directly (Codex, Cursor, Copilot
   coding agent), the delta file may not be needed at all.

A minimal delta file is one line. If a delta file grows a section that
isn't runtime-specific, move it to `AGENTS.md`, which the import brings back.

## Cross-runtime skill discovery (the symlink mirror)

Skills — packaged, named procedures an agent can invoke (see the
[glossary](../../GLOSSARY.md)) — are the one layer where runtimes scan
*different directories* for the *same kind of content*, so a pointer line
doesn't work — the runtime
needs real files in its scan path. The portable mechanism:

- Author skills once in one canonical directory (`.claude/skills/` by
  default; the script's `CANONICAL_DIR` names another).
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
are roles; these are the model families that filled them in 2026. Verify
against the vendor's current lineup and pricing before relying on them.

| Tier | Anthropic | OpenAI |
|------|-----------|--------|
| **Judgment** | Claude Fable-class | no separate counterpart named; the top reasoning tier of the flagship family is the nearest |
| **Strategic** | Claude Opus-class | GPT-5-class flagship |
| **Execution** | Claude Sonnet-class | mid-tier GPT |
| **Scout** | Claude Haiku-class | `*-mini` models |
| **Pin as** | a bare family alias ([below](#family-aliases-and-pins-in-claude-code)) | the undated model name, which points at the current snapshot, never a dated snapshot; where a runtime offers neither, one central name the repository maps to a release in a single place |

Long prompts can cost more than their length suggests: Anthropic's pricing
has billed a request whose prompt passes a length threshold at a higher rate
on some models (pricing documentation, checked 2026-10). That is why the
policy keeps scouts short and bounded; check the vendor's current pricing
page for the thresholds that apply.

### Family aliases and pins in Claude Code

From Claude Code's documentation on model configuration and sub-agents,
checked 2026-10; re-check after a CLI upgrade.

- **The aliases.** An agent's or skill's `model:` front matter takes a bare
  family alias, `fable`, `opus`, `sonnet` or `haiku`, which ordinarily
  resolves to that family's current release (the same-family and
  third-party-provider bullets below give the exceptions). A versioned id
  (`claude-…` with a date or release number) is accepted too, and that is the problem: it freezes the pin.
  `inherit` (in an agent's or a skill's `model:`) keeps the caller's model,
  as an omitted field does for a skill: neither is a pin, so a metadata
  check accepts both and derives no tier from them.
- **Invocation-time overrides.** A `model` passed when a subagent is invoked
  takes precedence over the subagent's `model:` front matter, and `--model`
  sets a spawned CLI's model the same way. A value chosen at the call site
  assigns a model outside the metadata the check reads, so the policy
  forbids it: route through a definition that carries the pin instead. A
  value the caller reads from that checked metadata or skill configuration
  and forwards unchanged declares nothing new and is allowed.
- **A subagent in the session's own family.** A family alias in a subagent's
  `model:` front matter, or in the model passed when it is invoked, resolves
  to the session's exact model, not the family's current release, when the
  session already runs a model of that family. A session on an older Opus
  release therefore runs a `model: opus` subagent on that older release too.
  An alias guarantees the current release only where neither this nor a
  provider override applies.
- **Third-party providers.** Through Amazon Bedrock, Google Cloud Vertex AI or
  another provider, an alias may resolve to an older release than it does on
  Anthropic's own API. A deployment there sets the provider's
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` (and the equivalent for any other family it
  uses) to the intended releases. That is environment configuration, outside
  what a repository's roster check can see.
- **Session model and pinned model.** The model chosen for a session
  (`/model`) runs the session and every skill that neither declares its own
  `model:` nor hands off to a pinned agent. The two ways to pin differ in how
  long the pin lasts. A subagent, and a skill that runs forked
  (`context: fork`), runs on its pin inside its own context, and the caller
  continues on its own model when it returns. An inline skill's `model:`
  instead switches the session's model for the rest of the current turn: the
  caller keeps running on it, gathering and editing included, until the next
  user prompt restores the session model. So a premium tier meant for one
  call belongs on a subagent or a forked skill, not an inline skill. A forked
  skill with no `model:` of its own but an `agent:` field runs on that
  agent's pin. Choosing
  the session model is a person's own cost and quality decision; moving a pin
  is governed by the policy.
- **Effort.** The `effort:` front matter field sets an agent's or skill's
  effort beside its pin; default effort differs between model generations, so
  a scout sets `effort: low` explicitly.

### Judgment-tier access and data retention

Vendor terms and runtime behaviour that change without notice; each line
carries the date it was observed. Re-check after a CLI upgrade and in each
account before a Judgment-tier layer runs unattended.

- **Data retention (vendor documentation, checked 2026-10).** Anthropic lists
  its Fable models as Covered Models: they require 30-day data retention, zero
  data retention is not available for them, and a request from an
  organisation or workspace whose retention settings do not meet that is
  rejected rather than downgraded
  ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#model-specific-data-retention-requirements)).
  An arrangement that keeps other families' payloads unretained does not
  extend to them.
- **Usage credits (observed 2026-10, Claude Code 2.1.x).** The CLI reports
  that a Fable session draws on usage credits rather than the plan's usage
  limits: a separate pool that runs out independently of the plan.
- **Enablement (observed 2026-10, Claude Code 2.1.x).** The CLI may ask for a
  one-time interactive step (`/model fable` in an interactive session) to
  review and enable the model. One headless run that spawned a subagent
  pinned to `fable`, in an account that had never taken that step, completed
  on the Fable model without an error: one data point, in one account and
  build, not a guarantee.
