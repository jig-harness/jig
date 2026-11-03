![Jig Harness](assets/brand/jig-frame.svg)

# Jig Harness

Jig is the rules a repository's AI coding agents follow, the skills they run and
the checks their work must pass. As a [harness](GLOSSARY.md), it carries each
change from pickup to merge. What one session learns, the next one keeps.

**A jig for AI coding agents: modular delivery practices, shared skills and gates, and an auditor that scores your repository.**

Jig Harness, Jig for short, takes its name from the workshop: a jig holds
the work and guides the tool so every cut comes out the same. Jig does that
for agents with checks every change must pass,
called [gates](GLOSSARY.md), and instructions an agent loads for one job,
called [skills](GLOSSARY.md). Every practice is a tool-independent rule
first, mapped to your tools second. You adopt it one module at a time.

## Jig as a software factory

A [software factory](GLOSSARY.md) takes work in a standard form, passes it
through the same stations and checks every time, and measures what comes
out. Jig's factory is one line, and agents run most of its stations. An
agent takes a work item from the issue tracker, builds it and opens a pull
request. The review rounds then run with nobody watching, and a bounded
repair round settles a red build or a conflict with the base. A person
merges. A follow-up then settles what the merge leaves open.

With nobody at the keyboard, the [dispatcher](GLOSSARY.md) keeps the line
moving. It restarts a review that stopped on something a machine can
settle, and tells a person about each stop only a person can settle.

The line stands on agent [scaffolding](GLOSSARY.md), and building it is most
of what Jig provides:

- **Context**: what an agent knows when a session starts: instruction files
  in layers, rules that load only where they apply, a glossary, and what each
  kind of change implies.
- **Verification**: guides that steer an agent before it acts, and checks
  that stop what slips through, with CI as the authority. Each rule names how
  hard it is to skip.
- **Knowledge**: decisions, facts and lessons kept in the repository, so the
  next session starts where the last one ended. A significant miss becomes a
  tested check.

[FACTORY.md](FACTORY.md) maps every station and who runs it, what stays with
a person, and what your own platform supplies.

Every term of art in this repository has a plain definition in
**[GLOSSARY.md](GLOSSARY.md)**. Start there when a word like "SSoT" or
"enforcement ladder" is new to you.

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
| [FEATURES.md](FEATURES.md) | What a team gets from Jig today: each feature with the skills that run it, the practice it carries out and what is on the roadmap for it |
| [FACTORY.md](FACTORY.md) | Jig as a software factory: the scaffolding it runs on, and its stations at the design-and-planning and execution levels |
| [ROADMAP.md](ROADMAP.md) | Open work, in priority order |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How a change to Jig is made, checked and merged |
| [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), [TRADEMARK.md](TRADEMARK.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Who decides, how to report a vulnerability, what you may do with the name, how we treat each other |
| [docs/](docs/README.md) | Jig's own documents: kinds, decision records, defaults |
| [design/](design/README.md) | Designs of roadmap items, until they are built |
| [principles/](principles/) | The seven design principles behind everything here |
| [modules/](modules/) | The practice modules, each independently adoptable |
| [profiles/](profiles/) | Module compositions: Solo/Lite, Team/Standard, Regulated/Strict |
| [adoption/](adoption/) | Greenfield and brownfield adoption paths |
| [seeds/](seeds/) | Imported source material, kept as-imported for provenance |
| [plugin/](plugin/README.md) | The `jig` plugin: agent skills for Claude Code and Codex (the pull-request drive loop, issue pickup, review resolution, conflict resolution, the [repository audit](plugin/skills/audit/README.md), and procedure skills), the `review-arbiter` agent, and [recommended third-party skills](plugin/RECOMMENDED-SKILLS.md) |
| [tools/](tools/README.md) | Runnable development tools |
| [website/](website/) | The jig-harness.dev site, rendered from this repository's documents at build time |

## Status

Every module carries the full module contract, and the auditor scores
the complete map. The plugin's version and what each release changed are in
[CHANGELOG.md](CHANGELOG.md); what comes next is in [ROADMAP.md](ROADMAP.md).

Jig is distilled from a production codebase built with AI agents, and
the repositories that use it keep feeding lessons back
(see [principles/05-learning-loop.md](principles/05-learning-loop.md)).

Jig is before 1.0: a minor version may change what a skill does or a
configuration field means, and the [change note](changes/README.md) of
each release says so. Pin the plugin to a release tag if you want to choose
when that reaches you ([plugin/README.md](plugin/README.md#update-pin-or-remove)).
One maintainer decides what goes in, and agents write most of the changes
([GOVERNANCE.md](GOVERNANCE.md)).

## Licence

Jig is licensed under the [Apache License 2.0](LICENSE). The template files
under `modules/*/templates/` and `plugin/skills/*/templates/`, which other repositories copy into their own,
are under [MIT No Attribution](LICENSE-MIT-0), so a copy needs no notice.
[NOTICE](NOTICE) lists those templates and the third-party code the plugin
vendors, each with its licence. Contributions from outside the maintainers
sign off each commit under the
[Developer Certificate of Origin](GLOSSARY.md)
([CONTRIBUTING.md](CONTRIBUTING.md#outside-contributions)); no contributor
licence agreement is asked for, and the licence will not change
([GOVERNANCE.md](GOVERNANCE.md#licence-copyright-and-name)). The name Jig
and the logo are trademarks held apart from the code
([TRADEMARK.md](TRADEMARK.md)). Report a vulnerability privately
([SECURITY.md](SECURITY.md)).

## Working on Jig

Install [mise](https://mise.jdx.dev/) and run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun install --frozen-lockfile --cwd website
mise exec -- bun run gates
```

The second install is the website's own dependencies (`website/` has its own
lockfile): the gates run its tests too.

The gate command checks formatting, lint, types, all gate self-tests, the build,
Markdown links/tables/glossary coverage, origin-reference exclusions, and the
change notes ([changes/](changes/README.md)) the release step writes into the
changelog after a merge.
GitHub Actions runs the same command on Linux for every pull request and
every push to `main`; there the long drive-pr suite runs in its own job,
split into parallel [test shards](GLOSSARY.md). A pull request runs the
drive-pr suite only when its changes need it, as Jig's
[change-area catalog](.config/change-areas.yaml) resolves them: when the
drive-pr skill or something it depends on changed. A push to `main` runs
everything. macOS and Windows run once a day, against `main`, in the nightly
workflow: the gate set, the drive-pr suite and the website's tests on both
(Windows leaves out only the POSIX-only suites, which [scripts/gates.ts](scripts/gates.ts)
lists with the reason).
The tests use Bun's built-in runner; `bun run test` runs them alone, one test
file per processor core at a time, with the per-test timeout the slower suites
need. `bun run format` formats TypeScript and configuration; `bun run build`
bundles the command entry points into the ignored `dist/` directory.

The runnable-tool layout and non-JavaScript consumer runtime choice are in
[tools/README.md](tools/README.md). The source checkout includes module-local
and shared imports; operate it as a complete pinned checkout.
