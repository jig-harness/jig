# groundwork

**AI-native delivery practices — template, reference, and auditor.**

Groundwork is a modular collection of software-delivery practices for teams that
build and maintain software with AI coding agents. It is deliberately
**vendor-agnostic** (the principles matter, not the specific tools) and
**tech-stack-flexible**. Its unifying idea: a repository should carry
scaffolding that lets AI agents operate it well over time — and everything else
(quality gates, documentation governance, review systems, learning loops) both
feeds that scaffolding and benefits from it.

New to these ideas? Every term of art used in this repo is defined in plain
language in **[GLOSSARY.md](GLOSSARY.md)** — start there whenever a word like
"SSoT" or "enforcement ladder" is unfamiliar.

## Ways to use this repo

1. **Greenfield template** — starting a new project: follow
   [adoption/greenfield.md](adoption/greenfield.md), which combines a structured
   kickoff methodology ([seeds/project-kickoff/](seeds/project-kickoff/)) with
   day-one module adoption.
2. **Brownfield upgrade** — improving an existing project: start with an
   **audit** ([audit/](audit/)) that scores the target repo against the module
   map and produces a prioritized, actionable report, then adopt modules one
   maturity rung at a time ([adoption/brownfield.md](adoption/brownfield.md)).
3. **Reference** — cherry-pick a single pattern (e.g., generated-artifact
   freshness gates) from its module.
4. **Shared tooling** — use Groundwork's agent skills in any repository without
   copying them: install the `groundwork` plugin once per machine for Claude
   Code or Codex and commit only your repository's values. See
   [plugin/README.md](plugin/README.md).

## Structure

| Path | What it holds |
|------|---------------|
| [GLOSSARY.md](GLOSSARY.md) | Plain-language definitions of every term of art |
| [PLAYBOOK.md](PLAYBOOK.md) | The end-to-end delivery narrative (feature pipeline + PR loop) |
| [ROADMAP.md](ROADMAP.md) | Build-out phases and current status |
| [principles/](principles/) | The seven design principles behind everything here |
| [modules/](modules/) | The 13 practice modules (M0–M12), each independently adoptable |
| [audit/](audit/) | The auditor: methodology, survey prompts, report template |
| [profiles/](profiles/) | Module compositions: Solo/Lite, Team/Standard, Regulated/Strict |
| [adoption/](adoption/) | Greenfield and brownfield adoption paths |
| [seeds/](seeds/) | Imported source material awaiting integration |
| [docs/](docs/) | Founding charter and background analysis |
| [plugin/](plugin/README.md) | The `groundwork` plugin: agent skills (`drive-pr`, `do-item`, `resolve-review-comments`) for Claude Code and Codex, and the `review-arbiter` agent for Claude Code ([Codex setup](plugin/README.md#codex-notes)) |
| [tools/](tools/README.md) | Runnable development tools |

## Status

**Standing backflow — the module map is complete.** All 13 modules (M0–M12)
carry the full module contract, and the auditor scores the complete map.
[ROADMAP.md](ROADMAP.md) is the sole continuation anchor for what is done,
what was deliberately deferred, and what comes next.

Groundwork is distilled from a production reference implementation (the
docomply monorepo — private), which remains "instance #1": lessons learned
there flow back here (see [principles/05-learning-loop.md](principles/05-learning-loop.md)).

Private repo; publishing (whole or per-module) is a deferred decision. No
license granted while private.

## Working on Groundwork

Install [mise](https://mise.jdx.dev/) and run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run gates
```

The gate command checks formatting, lint, types, all gate self-tests, the build,
Markdown links/tables/glossary coverage, and tracker-reference exclusions.
GitHub Actions runs the same command on Linux, macOS and Windows; there the
long drive-pr suite runs in its own job, split into four parallel
[test shards](GLOSSARY.md) on Linux and macOS, and Windows leaves out the
POSIX-only suites ([scripts/gates.ts](scripts/gates.ts) says which and why).
The tests use Bun's built-in runner; `bun run test` runs them alone (it sets
the per-test timeout the slower suites need). `bun run format` formats
TypeScript and configuration; `bun run build` bundles the command entry points
into the ignored `dist/` directory.

The runnable-tool layout and non-JavaScript consumer runtime choice are in
[tools/README.md](tools/README.md). The source checkout includes module-local
and shared imports; operate it as a complete pinned checkout.
