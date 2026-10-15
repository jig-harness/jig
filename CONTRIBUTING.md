# Contributing to Jig

How a change to Jig is made, checked and merged, for people and agents
alike. [AGENTS.md](AGENTS.md) holds the rules every session needs and points
here for the detail; [docs/](docs/README.md) says how Jig's own documents are
governed; [plugin/AGENTS.md](plugin/AGENTS.md) adds the rules for anything
under `plugin/`.

## Commits and pull requests

- Conventional Commits (`feat:`, `docs:`, `chore:`, …), on feature branches
  with pull requests against `main`.
- **One cohesive pull request per piece of work.** Related changes, such as
  the accepted recommendations of one audit or a round of documentation
  fixes, go in one pull request. Split only where a part needs its own
  decision by a person or the change grows past what one review can hold,
  and then by area, not by item. Small pull requests that touch the same
  files (this file, AGENTS.md, CHANGELOG.md, the configuration) conflict with
  each other at every merge.
- Every pull request records its user-visible change in
  [CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)):
  under the new plugin version's heading when it changes `plugin/`, under
  **Unreleased** otherwise.

## Parallel workspaces

Jig is worked in many [worktrees](GLOSSARY.md) of one clone at once, each
with its own agent ([M12](modules/M12-parallel-agent-ergonomics/README.md)),
so moves that are harmless alone collide here.

- **Reuse a branch before creating one**: `git fetch origin`, then
  `git branch -a` and the open pull requests; stop if the fetch fails.
  Otherwise two agents on one item open two diverging branches. When another
  worktree already has that branch checked out, its agent owns the item:
  work there only after that agent has stopped and handed it over, and never
  force a second checkout.
- **Never move work with `git stash`**: every worktree shares its stack, so a
  stash pushed in one can be popped in another. Commit work in progress
  instead.
- **Install only with `bun install`**: another package manager writes its own
  lockfile beside `bun.lock` and installs versions the gates and CI do not
  test.

## Pull-request lifecycle

Jig's own form of [M7's loop](modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md):

1. Before opening, read your whole diff against `main` as a reviewer
   would and run `bun run gates`.
2. Open the pull request as a draft. Jig's AI reviewer reviews drafts
   (`drive.reviews_drafts: true`), so the reviewers that skip drafts spend
   their pass on a head it has already cleaned.
3. Drive the review with `/jig:drive-pr`, which marks the pull request Ready
   after the first round (`pull_requests.mark_ready`), or one pass at a time
   with `/jig:resolve-review-comments`, marking it Ready yourself once that
   first round has settled. Every thread ends with a declared outcome and is
   resolved.
4. The pull request may merge once a round after Ready has settled: every
   reviewer has reported on the current head, no thread or summary finding is
   left unanswered, and the required checks are green. A person merges; an
   agent never does ([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)).
5. After the merge, run `/followup <PR>`
   ([.claude/skills/followup/](.claude/skills/followup/SKILL.md)): the
   tracker item and deferred findings, the release tag, what the merge did
   to the website, the status pages and documents that cite them, the
   consumer repositories, and cleanup. Its fixes go in one follow-up pull
   request.

## Jig's own skills

Skills for work on this repository, rather than for the repositories that
use Jig, live in `.claude/skills/` and are not part of the plugin; their
scripts live in `scripts/` with the repository's other tooling. Claude
Code finds them there. For Codex, run M0's mirror script once in each
worktree, since the links it makes live in the worktree and are ignored by
git:
`bun modules/M0-instruction-architecture/reference/sync-skills-mirror.ts`.

## Toolchain

Runnable tooling and gates are written in Bun + TypeScript
([ADR-0001](docs/adr/ADR-0001-bun-typescript-toolchain.md)): Bun runs
natively on macOS, Linux and Windows, where Bash runs only through a
compatibility layer and its standard utilities behave differently on macOS
and Linux. Bun is this repository's toolchain, not a requirement on consumer
repositories: tooling a non-JavaScript repository runs ships as a standalone
executable or is pinned through mise. The repository and module gates run
natively under the pinned Bun runtime.

## Quality gates

Dogfooded [M1](modules/M1-gates-enforcement-ladder/README.md), tiny by
design. Run all with one command: `bun run gates`. The set, in order:

1. the [always-loaded context](GLOSSARY.md) budget
   (`scripts/check-context-budget.ts`: M0's instruction-chain and
   skill-description budgets, which CI also runs before installing
   dependencies);
2. format, lint (Biome, with Jig's GritQL rules in `tools/quality/grit/`),
   types (`bun check`);
3. unused code, and the changed files' complexity and duplication (fallow);
4. the ratchet (below);
5. gate self-tests, then build;
6. the repository checks (`CHECKS` in `scripts/gates.ts`): Markdown links
   and the paths the `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` files
   name resolve; a blank line before every table; terms of art defined in the
   glossary (acronym proxy; escape hatch: `scripts/glossary-allowlist.txt`,
   each entry under a reason and removed once nothing uses it);
   no origin references; no workflow that runs a fork's code with secrets
   (M7's PR-target safety lint); the workflows meeting M13's pipeline
   conventions (the workflow-convention lint, with its heavy suites in
   `.config/workflow-conventions.yaml` and its reasoned exceptions in
   `.config/workflow-conventions-exceptions.txt`); the licence files and NOTICE complete
   (`scripts/check-licences.ts`); a changelog entry for the current plugin
   version; Jig's own audit record and configuration fitting the audit skill;
   every file belonging to an area of the change-area catalog
   (`.config/change-areas.yaml`); and the AI reviewer's high-risk paths
   matching the catalog's `reviewRisk: high` areas
   (`bun scripts/review-risk.ts --write` regenerates them).

CI runs the same command on Linux for every pull request
(`.github/workflows/gates.yml`); the catalog decides which of its jobs a pull
request needs. macOS and Windows run once a day against `main`
(`.github/workflows/nightly.yml`), and on demand from the Actions tab for a
branch likely to break on one of them. A new top-level file or directory gets an area in the catalog
in the same pull request.

Scope differs per gate, and each check script's header comment states exactly
what it skips and why: the Markdown gates leave vendored material (`seeds/`),
`templates/` and test `fixtures/` out, while the origin-reference gate covers
everything, vendored material and templates included, except test `fixtures/`
and its own pattern file.

`main`'s branch protection requires the `gates` check and every review
thread resolved, and forbids force-pushes and deleting the branch. It
requires nothing more: no approving review (a person merges) and no
up-to-date branch, which would cost a pull, a push and a full CI run on
every open pull request at each merge. `bun scripts/check-branch-protection.ts`
checks the setting against that policy; it needs an administrator's `gh`
login, so it runs by hand, not in CI.

Locally, `JIG_GATES_SKIP_SEPARATE_SUITES=1 bun run gates` leaves out the long
drive-pr suite and the website's tests, which CI runs in their own jobs; run
the test files for what you changed, and let CI run the rest. The website's
tests need `bun install` inside `website/` first.

### The ratchet

`bun run quality` (M1's [ratchet gate](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md))
fails a change that adds a finding to a rule at `warn` in `biome.json`, to a
flag in `tsconfig.ratchet.json`, or a suppression comment, measured against
the merge base. Fix the finding; do not suppress it. It also fails a change
that loosens a rule, unless a commit carries
`Ratchet-Loosen: <name>: <reason>` in its last paragraph. Never add that
trailer on your own initiative: only when a person has asked for that
loosening, and say so in the pull request. When the gate reports a rule at
zero, promote it to `error` (or move the flag into `tsconfig.json`).

### Local hooks

[`lefthook.yml`](lefthook.yml), with lefthook pinned in `mise.toml`: a commit
formats its staged files and re-stages them, and a push runs
`bun scripts/gates.ts --fast` (format, lint, types and the repository checks,
in seconds). Install them once per clone with
`mise install && lefthook install`; every worktree of the clone shares them.
`--no-verify` skips them, for a work-in-progress commit or push or a broken
hook, never to get past a check you have not read: CI runs every gate again,
so skipping never changes what merges.

## Derived files

[Generated artifacts](GLOSSARY.md) (M2) are never edited by hand: regenerate
them. Each row's drift check catches the failure named there. The example
indexes open with a "generated" header naming their generator. The lockfiles
and the vendored parsers cannot carry one, since each must stay byte for byte what
its generator writes, so this list is their marker.

| File | Regenerate | Drift check |
| --- | --- | --- |
| `bun.lock` | `bun install` after changing `package.json` | CI installs with `bun install --frozen-lockfile`, which fails when the lockfile no longer matches `package.json`; it does not catch an edit that keeps them in agreement |
| `website/bun.lock` | `bun install` in `website/` after changing `website/package.json` | the `website` job in `gates.yml` and the deploy in `website.yml` install with `bun install --frozen-lockfile` in `website/`, with the same limit as the row above |
| `plugin/skills/resolve-review-comments/scripts/lib/vendor/js-yaml.mjs` and its `js-yaml.LICENSE` | after updating `js-yaml`, copy `node_modules/js-yaml/dist/js-yaml.mjs` and `node_modules/js-yaml/LICENSE` (as `js-yaml.LICENSE`) into that folder | `tools/plugin/plugin.test.ts` compares both with the installed `js-yaml` |
| `lib/vendor/js-yaml.mjs` and its `js-yaml.LICENSE` (a second copy, because `lib/` is vendored without `plugin/`) | the same copy, into `lib/vendor/` | `lib/module-gates.test.ts` compares both with the installed `js-yaml` |
| `plugin/LICENSE` and `plugin/NOTICE` | `cp LICENSE NOTICE plugin/` after changing either (the plugin installs only `plugin/`) | `scripts/check-licences.ts` compares them with the root files |
| `high_risk_path_patterns` in `.config/ai-review.yaml` | `bun scripts/review-risk.ts --write` after changing a `reviewRisk: high` area | the gates' `review-risk` check compares it with the catalog |
| `modules/M2-generated-artifact-freshness/reference/triad/fixture/docs/index.md` | `bun modules/M2-generated-artifact-freshness/reference/triad/generate-index.ts modules/M2-generated-artifact-freshness/reference/triad/fixture/docs` | `scripts/freshness.test.ts` runs `check-index-fresh.ts` against it |
| `modules/M4-docs-governance/reference/index/fixtures/docs/INDEX.md` | `bun exec "DOCS_DIR=modules/M4-docs-governance/reference/index/fixtures/docs bun modules/M4-docs-governance/reference/index/generate-index.ts"` (Bun's shell sets the variable on every operating system) | `generate-index.test.ts` beside the generator compares it with a fresh generation |
| `modules/M4-docs-governance/reference/index/fixtures/docs/.orphans.md` | the same command as `INDEX.md`, which writes both; its date is sticky, so it changes only when the report's content does | `generate-index.test.ts` compares it with a fresh generation dated another day |

A new derived file gets a row here in the pull request that adds it.

## Keeping the auditor current

Nearly every change to Jig moves what `/jig:audit` should see: a new or
changed skill, configuration field, module practice, criterion, gate or
template. Each pull request, and every feature without exception,
re-evaluates the audit skill ([plugin/skills/audit/](plugin/skills/audit/SKILL.md))
against the change: does `config-schema.yaml` list the field, its type and its
readers; do the criteria and their probes still describe the practice; does
`config-fit.ts` check what the change makes checkable; does Jig's own record
(`.config/jig-audit.yaml`) still hold. The pull request description says what
changed in the audit, or why nothing needed to.

The record scores the commit it audited, so a pull request leaves the scores
of existing criteria as they are: the next audit scores the change, and the
pull request names the criteria it targets. A pull request that adds, renames
or removes a criterion is the exception: it updates the record's entries for
those criteria in the same change, scoring a new or renamed one against the
commit the record already audited and dropping a removed one. The gates
enforce the mechanical half: such a change fails until the record matches the
criteria, and Jig's configuration must fit the schema; the rest is this
review.

## Licences

Jig is under the Apache License 2.0 ([LICENSE](LICENSE)); the files under
`modules/*/templates/` are under MIT No Attribution
([LICENSE-MIT-0](LICENSE-MIT-0)). [NOTICE](NOTICE) names the licensor, lists
those template files one by one, and lists the third-party code the plugin
vendors with the licence file beside each. A new template gets its line in
NOTICE, and vendored code arrives with its licence file and a NOTICE entry;
`scripts/check-licences.ts` in the gates fails until they do.

## Outside contributions

A contribution from outside the maintainers is accepted under the project's
licence: sign off each commit (`git commit -s`), which adds a
`Signed-off-by:` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/), that
you wrote the change or otherwise have the right to submit it.

## Releasing the plugin

This repository is the `jig` plugin: both agent tools install `plugin/` from
`main` ([ADR-0002](docs/adr/ADR-0002-the-plugin-is-its-directory.md)). The
rules for changing anything under `plugin/` (running from a copy outside this
repository, the version bump, the release tag) are in
[plugin/AGENTS.md](plugin/AGENTS.md).
