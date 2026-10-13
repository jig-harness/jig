# Jig Agent Instructions

Context for AI coding agents working **on the Jig repo itself**.
Compatible with Claude Code, Codex, Cursor, and others.

This file holds what every session needs: what Jig is, where to read next,
the rules no change may break, and pointers. Keep it that way: practice
detail belongs in the document of its kind ([docs/](docs/README.md) says
which), and this file links to it only when every session needs to know it
exists.

## What this repo is

Jig distills the delivery practices of a mature AI-native codebase into
a vendor-agnostic, tech-stack-flexible, modular template. Its uses:
greenfield template, brownfield upgrade path, **runnable auditor** that scores
a repository and produces actionable recommendations, and **shared runnable
tooling** — the agent skills and development tools (PR review loops, issue
pickup, conflict resolution, gates) that repositories use instead of
copying. Skills ship as the `jig` plugin for Claude Code and Codex,
installed once per machine ([plugin/README.md](plugin/README.md)).

The placement rule for that tooling: a generic mechanism lives here; an
organization's values (tracker team and labels, review bots, gate commands,
host names) stay in that organization's own repositories and reach the tooling
as configuration; product-bound code never comes here.

Read in this order when starting a session here:

1. [ROADMAP.md](ROADMAP.md) — what is open and in which order (the
   continuation anchor), and [design/](design/README.md) for the items that
   have a design. Finished work is in [CHANGELOG.md](CHANGELOG.md).
2. [CONTRIBUTING.md](CONTRIBUTING.md) before your first change: pull
   requests, the gates, hooks, derived files, keeping the auditor current.
3. The instructions closest to what you change: [plugin/AGENTS.md](plugin/AGENTS.md)
   for skills and the plugin, [modules/AGENTS.md](modules/AGENTS.md) for the
   practice modules. They add to this file; they do not repeat it.
4. The module(s) or skill(s) you are working on.

## Writing conventions (MANDATORY)

- **Plain language first.** Jig must be accessible to readers unfamiliar
  with any of these techniques. Expand jargon on first use per document and
  link it to [GLOSSARY.md](GLOSSARY.md). When you introduce a new term of art,
  add it to the glossary in the same commit. Every module README opens with a
  plain-language "what problem this solves / what it looks like without it"
  paragraph before any mechanism detail.
- **Invariant before tools.** State each practice as a tool-independent
  invariant, then map concrete implementations per ecosystem in the module's
  `mappings.md`. Derive-don't-declare: prefer detecting a repository's stack
  over asking for configuration. Runnable tooling may be bound to a named
  tool (Linear, GitHub, Herdr) behind an interface a second implementation
  can be added to without touching callers.
- **Values vs mechanisms.** Material taken from a working repository is split:
  the repo-agnostic mechanism goes into `reference/` (or a skill), that
  repository's values become placeholders, configuration or neutral
  examples. Where the source hasn't made that split, make it on the way in.
- **No origin references.** Jig names no organization it learned from: no
  organization or product names, no issue-tracker keys or links, no
  pull-request numbers or paths from another repository, in documents, code
  comments, test names and test data alike, and none of its domain content
  (when in doubt, leave it out and note the gap). Rationale must stand on its own, at the code or in the module
  documentation. Enforced by `scripts/check-no-tracker-refs.ts`, with its
  patterns and allowed places in `scripts/tracker-key-patterns.txt`.
- **De-scarring.** Final documents and code comments carry no review-finding
  traces, reviewer dialogue, or "addressed/fixed" annotations — that history
  lives in PRs and issues. State the rule as it is now, not the change that
  made it so.
- **Status pages say what is open, not what happened.** [ROADMAP.md](ROADMAP.md)
  lists open work only; a finished item leaves it in the same pull request
  that finishes it, and what changed goes into [CHANGELOG.md](CHANGELOG.md).
- **Don't bring in the unproven; move, never copy.** Dark-by-default dials,
  unvalidated eval fixtures and aspirational hooks stay out until a working
  repository has validated them (note them as "future" in the module README).
  Bring a tool in by moving the operated source here, with its tests, and
  deleting the source repository's copy in the same rollout: a rewritten
  copy becomes a fork the moment the original takes its next fix.
- Markdown: blank line before every table (many renderers break otherwise).

## Learning from the repositories that use Jig

- A repository that uses Jig is a **consumer repository**
  ([GLOSSARY.md](GLOSSARY.md)): Jig states the general pattern, the consumer
  holds one concrete, battle-tested implementation.
- **Backflow**: when a consumer learns something (a new lens, gate, or
  corrected design), evaluate it for Jig and bring in the *corrected* design,
  not the first attempt.
- Jig must never *require* access to any particular consumer: everything a
  consumer needs is here, and its own values arrive as configuration.

## Rules for every change

How to apply each is in [CONTRIBUTING.md](CONTRIBUTING.md).

- **One cohesive pull request per piece of work**, against `main`, with
  Conventional Commits and a [CHANGELOG.md](CHANGELOG.md) entry. Never split
  related work into small pull requests that touch the same files.
- **Run `bun run gates` before pushing**, and fix what fails rather than
  suppressing it. Never add a `Ratchet-Loosen` trailer unless a person asked
  for that loosening.
- **Parallel worktrees**: reuse a branch before creating one, never move work
  with `git stash`, install only with `bun install`.
- **Pull requests** open as drafts and are driven until every thread is
  resolved; a person merges, an agent never does.
- **Never edit a derived file by hand**; regenerate it.
- **Keep the auditor current**: re-evaluate the audit skill against the
  change, and say in the pull request what changed in the audit.
- **Anything under `plugin/`** follows [plugin/AGENTS.md](plugin/AGENTS.md):
  it ships as a new version.
- **Standing decisions** are in [docs/adr/](docs/adr/); read the record before
  deciding something it settles. When several approaches are viable and no
  rule decides, lean the way [docs/dispositions.md](docs/dispositions.md) says.
- **HITL (human-in-the-loop) decisions**: publishing/visibility, license,
  deleting seed material, and anything touching the origin-reference
  boundary — flag, don't act.
