![Jig](assets/brand/jig-frame.svg)

# Jig

**AI-native delivery practices — template, reference, and auditor.**

Jig is a modular collection of software-delivery practices for teams that
build and maintain software with AI coding agents. A jig, in a workshop, holds
the work and guides the tool so every cut comes out the same; these skills and
gates do that for agents. It is deliberately
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
   **audit** ([`/jig:audit`](plugin/skills/audit/README.md)) that scores the repository against the module
   map and produces a prioritized, actionable report, then adopt modules one
   maturity level at a time ([adoption/brownfield.md](adoption/brownfield.md)).
3. **Reference** — cherry-pick a single pattern (e.g., generated-artifact
   freshness gates) from its module.
4. **Shared tooling** — use Jig's agent skills in any repository without
   copying them: install the `jig` plugin once per machine for Claude
   Code or Codex and commit only your repository's values. See
   [plugin/README.md](plugin/README.md).

## Structure

| Path | What it holds |
|------|---------------|
| [GLOSSARY.md](GLOSSARY.md) | Plain-language definitions of every term of art |
| [PLAYBOOK.md](PLAYBOOK.md) | The end-to-end delivery narrative (feature pipeline + PR loop) |
| [ROADMAP.md](ROADMAP.md) | Open work, in priority order |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How a change to Jig is made, checked and merged |
| [docs/](docs/README.md) | Jig's own documents: kinds, decision records, defaults |
| [design/](design/README.md) | Designs of roadmap items, until they are built |
| [principles/](principles/) | The seven design principles behind everything here |
| [modules/](modules/) | The 13 practice modules (M0–M12), each independently adoptable |
| [profiles/](profiles/) | Module compositions: Solo/Lite, Team/Standard, Regulated/Strict |
| [adoption/](adoption/) | Greenfield and brownfield adoption paths |
| [seeds/](seeds/) | Imported source material, kept as-imported for provenance |
| [plugin/](plugin/README.md) | The `jig` plugin: agent skills for Claude Code and Codex (the pull-request drive loop, issue pickup, review resolution, conflict resolution, the [repository audit](plugin/skills/audit/README.md), and procedure skills), the `review-arbiter` agent, and [recommended third-party skills](plugin/RECOMMENDED-SKILLS.md) |
| [tools/](tools/README.md) | Runnable development tools |

## Status

Every module (M0–M12) carries the full module contract, and the auditor scores
the complete map. The plugin's version and what each release changed are in
[CHANGELOG.md](CHANGELOG.md); what comes next is in [ROADMAP.md](ROADMAP.md).

Jig is distilled from a production codebase built with AI agents, and
the repositories that use it keep feeding lessons back
(see [principles/05-learning-loop.md](principles/05-learning-loop.md)).

The repository is private; whether and when to publish it, whole or per
module, is still open.

## Licence

Jig is licensed under the [Apache License 2.0](LICENSE). The template files
under `modules/*/templates/`, which other repositories copy into their own,
are under [MIT No Attribution](LICENSE-MIT-0), so a copy needs no notice.
[NOTICE](NOTICE) lists those templates and the third-party code the plugin
vendors, each with its licence. Contributions from outside the maintainers
sign off each commit under the
[Developer Certificate of Origin](GLOSSARY.md)
([CONTRIBUTING.md](CONTRIBUTING.md#outside-contributions)).

## Working on Jig

Install [mise](https://mise.jdx.dev/) and run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run gates
```

The gate command checks formatting, lint, types, all gate self-tests, the build,
Markdown links/tables/glossary coverage, origin-reference exclusions, and a
changelog entry for the current plugin version.
GitHub Actions runs the same command on Linux, macOS and Windows; there the
long drive-pr suite runs in its own job, split into four parallel
[test shards](GLOSSARY.md) on Linux and macOS, and Windows leaves out the
POSIX-only suites ([scripts/gates.ts](scripts/gates.ts) says which and why).
A pull request runs only the jobs its changes need, as Jig's
[change-area catalog](.config/change-areas.yaml) resolves them: the drive-pr
suite when the drive-pr skill or something it depends on changed, and macOS
and Windows when anything outside documentation changed. Linux always runs
the whole gate set, and a push to `main` runs everything.
The tests use Bun's built-in runner; `bun run test` runs them alone, one test
file per processor core at a time, with the per-test timeout the slower suites
need. `bun run format` formats TypeScript and configuration; `bun run build`
bundles the command entry points into the ignored `dist/` directory.

The runnable-tool layout and non-JavaScript consumer runtime choice are in
[tools/README.md](tools/README.md). The source checkout includes module-local
and shared imports; operate it as a complete pinned checkout.
