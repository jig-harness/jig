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

## Three ways to use this repo

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

## Status

**Phase 2 (bootstrap) — kernel in place.** Structure, principles, glossary,
auditor v0, and module definitions exist; module `templates/` and `reference/`
implementations are being ported from the reference implementation. See
[ROADMAP.md](ROADMAP.md) for exactly what is done and what comes next.

Groundwork is distilled from a production reference implementation (the
docomply monorepo — private), which remains "instance #1": lessons learned
there flow back here (see [principles/05-learning-loop.md](principles/05-learning-loop.md)).

Private repo; publishing (whole or per-module) is a deferred decision. No
license granted while private.
