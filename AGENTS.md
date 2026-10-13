# Jig Agent Instructions

Context for AI coding agents working **on the Jig repo itself**.
Compatible with Claude Code, Codex, Cursor, and others.

## What this repo is

Jig distills the delivery practices of a mature AI-native codebase into
a vendor-agnostic, tech-stack-flexible, modular template. Its uses:
greenfield template, brownfield upgrade path, **runnable auditor** that scores
a target repo and produces actionable recommendations, and **shared runnable
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
2. The instructions closest to what you change: [plugin/AGENTS.md](plugin/AGENTS.md)
   for skills and the plugin, [modules/AGENTS.md](modules/AGENTS.md) for the
   practice modules. They add to this file; they do not repeat it.
3. The module(s) or skill(s) you are working on.

## Writing conventions (MANDATORY)

- **Plain language first.** Jig must be accessible to readers unfamiliar
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
- **Values vs mechanisms.** Material taken from a working repository is split:
  the repo-agnostic mechanism goes into `reference/` (or a skill), that
  repository's values become placeholders, configuration or neutral
  examples. Where the source hasn't made that split, make it on the way in.
- **No origin references.** Jig names no organization it learned from:
  no organization or product names, no issue-tracker keys or links, no
  pull-request numbers or review rounds from another repository, no paths
  that exist only there — in documents, code comments, test names and test
  data alike. Rationale must stand on its own: in the module documentation,
  or in a comment at the code whose shape needs explaining. When bringing code
  in, restate the rationale a reference pointed to where the shape is
  non-obvious, and drop it where the code already makes the reason evident.
  Never import another organization's domain content (its product concepts,
  tier names, customer data); replace product examples with neutral ones, and
  when in doubt leave it out and note the gap. Enforced by
  `scripts/check-no-tracker-refs.ts`; the patterns and the few allowed places
  (the repository's own address, the manifests' publisher fields, this
  repository's own configuration) live in `scripts/tracker-key-patterns.txt`.
- **De-scarring.** Final documents and code comments carry no review-finding
  traces, reviewer dialogue, or "addressed/fixed" annotations — that history
  lives in PRs and issues. State the rule as it is now, not the change that
  made it so.
- **Status pages say what is open, not what happened.** [ROADMAP.md](ROADMAP.md)
  lists open work only; a finished item leaves it in the same pull request
  that finishes it, and what changed goes into [CHANGELOG.md](CHANGELOG.md).
  Module READMEs describe what the module provides and what it deliberately
  leaves out, not the history of how it got there.
- **Don't bring in the unproven; move, never copy.** Dark-by-default dials,
  unvalidated eval fixtures, and aspirational hooks stay out until a working
  repository has validated them — note them as "future" in the module README
  instead. Active use shows that tooling is needed, not that every part of it
  is validated: a moved tool brings its own tests, and any part of it that is
  dark by default or unvalidated still stays out. Bring a tool in by moving the
  operated source here and deleting the source repository's copy in the same
  rollout, never by rewriting a parallel copy. A rewritten copy becomes a fork
  the moment the original takes its next fix.
- Markdown: blank line before every table (many renderers break otherwise).

## Learning from the repositories that use Jig

- A repository that uses Jig is an **instance**, not upstream:
  Jig states the general pattern; the instance holds one concrete,
  battle-tested implementation.
- **Backflow**: when an instance learns something (a new lens, gate, or
  corrected design), evaluate it for Jig. Bring in the *corrected*
  design, not the first attempt — e.g., derivable-fact freshness landed as
  "CI-check without committing the derived file" after materialized copies
  proved a merge-conflict liability (prefer: drop > CI-check > commit).
- Jig must never *require* access to any particular instance to be
  useful: everything a consumer needs is here, and each consumer's own values
  arrive as configuration.

## Ways of working in this repo

- Conventional Commits (`feat:`, `docs:`, `chore:`, …), on feature branches
  with pull requests against `main`. Every pull request records its
  user-visible change in [CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)):
  under the new plugin version's heading when it changes `plugin/`, under
  **Unreleased** otherwise.
- **Parallel workspaces.** Jig is worked in many
  [worktrees](GLOSSARY.md) of one clone at once, each with its own agent
  ([M12](modules/M12-parallel-agent-ergonomics/README.md)), so moves that
  are harmless alone collide here. Reuse a branch before creating one
  (`git fetch origin`, then `git branch -a` and the open pull requests; stop
  if the fetch fails), or two agents on one item open two diverging
  branches. When another worktree already has that branch checked out, its
  agent owns the item: work there only after that agent has stopped and
  handed it over, and never force a second checkout. Never move work with `git stash`: every
  worktree shares its stack, so a stash pushed in one can be popped in
  another; commit work in progress instead. Install only with `bun install`:
  another package manager writes its own lockfile beside `bun.lock` and
  installs versions the gates and CI do not test.
- **Pull-request lifecycle** (Jig's own form of
  [M7's loop](modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md)).
  Before opening, read your whole diff against `origin/main` as a reviewer
  would and run `bun run gates`. Open the pull request as a draft: Jig's AI
  reviewer reviews drafts (`drive.reviews_drafts: true`), so the reviewers
  that skip drafts spend their pass on a head it has already cleaned. Drive
  the review with `/jig:drive-pr`, which marks the pull request Ready after
  the first round (`pull_requests.mark_ready`), or one pass at a time with
  `/jig:resolve-review-comments`, marking it Ready yourself once that first
  round has settled. Every thread ends with a declared outcome and is
  resolved. The pull request may merge once a round after Ready has settled:
  every reviewer has reported on the current head, no thread or summary
  finding is left unanswered, and the required checks are green. A person
  merges; an agent never does.
- **Toolchain.** Runnable tooling and gates are written in Bun + TypeScript:
  Bun runs natively on macOS, Linux and Windows, where Bash runs only through
  a compatibility layer and its standard utilities behave differently on macOS
  and Linux. Bun is this repository's toolchain, not a requirement on target
  repositories — tooling a non-JavaScript repository runs ships as a
  standalone executable or is pinned through mise. The repository and module
  gates run natively under the pinned Bun runtime.
- Quality gates (dogfooded M1, tiny by design) — run all with one command:
  `bun run gates`. The set, in order: format, lint (Biome, with Jig's
  GritQL rules in `tools/quality/grit/`), types (`bun check`), unused code
  and the changed files' complexity and duplication (fallow), the ratchet,
  gate self-tests, build, Markdown links resolve, blank line before tables, terms of art
  defined in the glossary (acronym proxy; escape hatch:
  `scripts/glossary-allowlist.txt`), no origin references, a changelog
  entry for the current plugin version, Jig's own audit record and
  configuration fitting the audit skill, and every file belonging to an area
  of Jig's change-area catalog (`.config/change-areas.yaml`). CI runs the
  same command on every PR (`.github/workflows/gates.yml`); the catalog
  decides which of its jobs a PR needs. A new top-level file or directory
  gets an area in the catalog in the same PR. Scope differs per gate, and each check
  script's header comment states exactly what it skips and why: the Markdown
  gates leave vendored material (`seeds/`), `templates/` and test `fixtures/`
  out, while the origin-reference gate covers everything, vendored material
  and templates included, except test `fixtures/` and its own pattern file.
  Locally, `JIG_GATES_SKIP_SEPARATE_SUITES=1 bun run gates` leaves out
  the long drive-pr suite; run its test files for what you changed, and let
  CI's shards run the rest.
- **The ratchet** (`bun run quality`; M1's
  [ratchet gate](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md))
  fails a change that adds a finding to a rule at `warn` in `biome.json`, to
  a flag in `tsconfig.ratchet.json`, or a suppression comment, measured
  against the merge base. Fix the finding; do not suppress it. It also fails
  a change that loosens a rule, unless a commit carries
  `Ratchet-Loosen: <name>: <reason>` in its last paragraph. Never add that trailer on your own
  initiative: only when a person has asked for that loosening, and say so in
  the pull request. When the gate reports a rule at zero, promote it to
  `error` (or move the flag into `tsconfig.json`).
- **Keep the auditor current.** Nearly every change to Jig moves what
  `/jig:audit` should see: a new or changed skill, configuration field,
  module practice, criterion, gate or template. Each pull request, and every
  feature without exception, re-evaluates the audit skill
  ([plugin/skills/audit/](plugin/skills/audit/SKILL.md)) against the change:
  does `config-schema.yaml` list the field, its type and its readers; do the
  criteria and their probes still describe the practice; does `config-fit.ts`
  check what the change makes checkable; does Jig's own record
  (`.config/jig-audit.yaml`) still hold. The pull request description says
  what changed in the audit, or why nothing needed to. The gates enforce the
  mechanical half: a criterion added, renamed or removed fails until Jig's
  record scores it, and Jig's configuration must fit the schema; the rest is
  this review.
- **This repository is the `jig` plugin.** Both tools install it from
  `main`; the rules for changing anything under `plugin/` (running from a copy
  outside this repository, the version bump, the release tag) are in
  [plugin/AGENTS.md](plugin/AGENTS.md).
- HITL (human-in-the-loop) decisions: publishing/visibility, license, deleting
  seed material, and anything touching the origin-reference boundary — flag,
  don't act.
