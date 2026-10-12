# Roadmap

What Groundwork still has to build, in priority order. A session picking up
Groundwork work starts here.

This page lists open work only. When an item is finished it leaves this page:
what changed is recorded in [CHANGELOG.md](CHANGELOG.md), and how things work
now is documented where they live (module READMEs, the
[plugin](plugin/README.md), [CONFIGURATION.md](plugin/CONFIGURATION.md)).
Background on how the module map came about is in
[principles/](principles/README.md) and [modules/](modules/README.md).

## Now

### 1. Rename Groundwork to jig

A jig holds the work and guides the tool so every cut comes out the same;
that is what these skills and gates do for agents. The short name also shortens
every command (`/jig:drive-pr`). Renaming breaks every repository that uses
the plugin, so it happens once, before anything is published, in one release
with the consumers' changes paired:

- the GitHub repository (renamed `jig` within the same organization; GitHub
  redirects the old address, but install commands, marketplace registrations,
  links and the origin-reference gate's allowed address move to the new one);
- the plugin and both marketplaces (`groundwork@groundwork` → `jig@jig`), the
  manifests, and the `/groundwork:` command prefix in every skill, document
  and consumer instruction;
- the configuration file (`.config/groundwork-overlay.yaml` → `.config/jig.yaml`),
  still read under its old name for a transition period, with a message naming
  the rename;
- the `GROUNDWORK_*` environment variables (old names still read for the same
  period), the state directories (migrated, as `migrate-state-dir.ts` does
  today), and the package name;
- the brand: the logo files (a horizontal lockup, a stacked mark on dark, and a
  round mark) go into the repository, with the README header and any icon
  field the two plugin manifests support.

Every machine that uses the plugin installs the renamed one and removes the
old; the changelog's entry for the release says exactly how.

### 2. Licence

Apache-2.0 for the repository, MIT-0 for the templates (skeletons other
repositories paste in without carrying a notice), with the organization that
publishes Groundwork as the licensor. The MIT-0 exception names the template
files themselves, not a directory, so it holds after item 3 moves them into
skills and item 4 merges M6's with the kickoff's. A `LICENSE` at the root and a copy in `plugin/` (the plugin installs
only that directory), a `NOTICE` naming the vendored js-yaml and `ste-lint`
code and their licences, `license` fields in `package.json` and both
manifests, a licence section in the README, and a gate that every vendored
directory carries its licence file. The origin-reference gate's allowed
places gain `LICENSE` and `NOTICE`, which name the licensor. Outside contributions, once accepted,
use a [Developer Certificate of Origin](GLOSSARY.md) sign-off.

### 3. Skill assets live in the plugin

The plugin installs only `plugin/`, so a skill cannot read anything under
`modules/`. Templates, gates and criteria a skill uses move into the skill
that uses them (moved, not copied), and the module links to them there: one
source, nothing to keep in step. This unblocks items 4–6, which need M6's
templates, M4's gates and every module's `maturity.yaml`. The module contract
changes in the same pull request: [modules/AGENTS.md](modules/AGENTS.md)
requires `templates/`, `reference/` and `maturity.yaml` in every module
directory, and `audit/score-modules.ts` reads `modules/*/maturity.yaml`, so
the contract, the auditor and its coverage check move to the new location
together, and each module links to the assets it no longer holds. Moving the plugin to
the repository root is not an option: the root `package.json` would make each
tool install the development dependencies on every machine.

### 4. The kickoff family

The greenfield kickoff becomes a living skill instead of a frozen seed, with
the skills it calls, written by this repository's author and free of
third-party lineage. Each moves from its source (the author's personal skill
workspace, whose copies are deleted in the same rollout):

- **`kickoff`**: the project bootstrap (requirements, architecture,
  red team, synthesis, repository bootstrap, plan review, developer
  documentation, scaffolding, agent hierarchy, implementation plans, tracker).
  It replaces `seeds/project-kickoff/`, which is an older copy. M6's PRD and
  architecture templates and the kickoff's own are merged into one of each.
  The opinions M6 leaves out (personas, tiers, model routing) belong in the
  skill, not the module.
- **`red-team`**: adversarial review of a requirements or architecture
  document by persona (critical chief technology officer, security auditor, performance engineer,
  cost optimizer), in a fresh session; the runnable form of M6's per-stage
  adversarial review.
- **Plan review**, folded into `review`, which already accepts a plan
  document: dependencies and critical path, completeness, simplification and
  effort checks.
- **`docs`**: the runnable form of M4: runs the repository's frontmatter,
  index and scar checks, flags stale drafts, and plans missing documentation by
  project type. The repository's M4 schema wins over the source skill's own
  frontmatter rules.
- **`upgrade-deps`**: grouped, changelog-driven dependency upgrades (the
  majors an update bot cannot do alone), opened through `do-item`'s
  pull-request policy and driven by `drive-pr`; the runnable side of M1's
  pin-and-update rule.
- **`design-brief-builder`**: two copies have diverged; merge the source's
  `failure-modes`, `bundle-contract` and `creative-latitude` references into
  this one.

[adoption/greenfield.md](adoption/greenfield.md) then points at
`/jig:kickoff` instead of the seed.

### 5. `changelog` skill

Keeps a repository's changelog as a practice, not an afterthought, in either
common format, detected from the file or set in configuration:
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) (an
`Unreleased` section filled as changes merge; `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`) or
[Common Changelog](https://common-changelog.org/) (written at release time
from the history; `Changed`, `Added`, `Removed`, `Fixed`; every entry
imperative, one line, with references; breaking changes marked and listed
first; no `Unreleased`).

- **Draft** entries from the merged pull requests and commits since the last
  release: rewritten for a reader, noise removed, related changes merged,
  breaking changes marked with what a consumer must do.
- **Check**, against the rules of the detected format rather than a union of
  both: structure, category names and order, dates written year-month-day,
  link references, and release coverage. Each rule, its conditions and its
  exemptions are taken from the format's own specification, cited where the
  check enforces them, not restated here. Groundwork's own
  `scripts/check-changelog.ts` is the starting point, not the finished check:
  it reads Groundwork's two plugin manifests and checks only that their
  versions agree and that the current one has a heading. The skill's check
  detects the format, validates the rules above, and takes the current version
  from the repository rather than from fixed paths; Groundwork's `bun run
  gates` keeps calling it.
- **Release**: write the version's section (or move `Unreleased` into it),
  update the comparison links, and leave tagging to the release step.
- `do-item` and `drive-pr` ask for an entry when a pull request changes what
  users see, where the format keeps one per change.

The practice itself (a changelog per released artifact, mechanically
checked) belongs in a module; decide whether M10 (environments and deploy)
holds it or a new release module does.

### 6. `/jig:audit`

The auditor as a plugin skill a repository runs again and again, not a
one-time adoption step. Today the [auditor](audit/README.md) is a method, survey
prompts and a checklist generator that an agent follows by hand from a
Groundwork checkout; a repository that installs the plugin cannot run it, and
nothing records what an earlier audit found.

What it does:

1. **Configuration fit** (mechanical, a script). Reads the repository's
   `.config/jig.yaml` and reports unknown or deprecated keys,
   wrong types, derivations that fail (the gate command does not exist, the
   base branch's protection cannot be read, a required check never runs, the
   tracker cannot be reached), declared values the repository contradicts (for
   example `stacking: none` with stacked pull requests open), and features the
   repository's shape suggests but does not use. The field list comes from one
   machine-readable schema, which [CONFIGURATION.md](plugin/CONFIGURATION.md)
   and the skills' own validation also use, so the three cannot drift.
2. **Maturity scoring.** Scores every module's `maturity.yaml` criteria against
   the repository. A criterion that names an observable fact (a file exists, a
   CI job runs on pull requests, a hook is configured) gains an optional
   machine `probe` the script evaluates; the rest are judged by the agent from
   the survey prompts, with file-path evidence, as
   [audit/methodology.md](audit/methodology.md) requires.
3. **A committed record**, `.config/jig-audit.yaml`: the plugin version
   audited, the date, each criterion's score and evidence, and the
   recommendations the team declined, each with a reason and a condition for
   revisiting it. A re-run compares against the record and reports what is
   fixed, still open, regressed or new, and does not repeat a declined
   recommendation until its condition holds.
4. **`since: <version>` markers** on configuration fields and maturity
   criteria, so a re-run can say what Groundwork added since the last audit.
5. **Read-only by default.** Applying a recommendation is a separate, opt-in
   step that opens one pull request per recommendation (through `do-item`'s
   pull-request policy), never a bulk change.
6. **Several repositories**: the
   [portfolio comparison](audit/portfolio-methodology.md) runs over the
   per-repository records instead of re-auditing.

Design points to settle in the pull request:

- The criteria live in the skill after item 3, in the same `maturity.yaml`
  schema; the skill reads them there, and each module links to its own.
- `audit/` moves into `plugin/skills/audit/` (moved, not copied), leaving a
  pointer in `audit/README.md`.
- Done when the skill audits Groundwork itself (its record committed here) and
  one external repository, as the
  [calibration run](audit/calibration/2026-07-19-execa.md) did by hand.

## Next

### 7. Delegated merge (`pull_requests.merge: auto-on-converged`)

Lets a converged drive arm the forge's auto-merge for the exact head it
certified. It relaxes "a human merges", so the doctrine change is approved on
its own. Work in progress is on branch `feature/auto-merge-on-converged`;
before it opens as a pull request the design must guarantee that:

- the delegation and the merge method are read only from sources the pull
  request cannot change, fetched fresh at the moment of the decision, and the
  integration branch is resolved independently of the pull request's own
  `repository.base_branch`;
- revoking the delegation, or any condition that refuses it, withdraws an
  auto-merge an earlier run armed, whatever the policy then says;
- `drive.ts` leaves the decision to the helper instead of gating on the pull
  request's own copy of the policy;
- an armed auto-merge is bound to the certified head and cannot arm before the
  reviewers summoned by Ready have reported;
- the doctrine (M7 invariant, the human-in-the-loop registry's Merge row, the
  maturity criteria) changes in the same pull request, in the direction the
  decision picks.

### 8. Values the skills still assume

Move into configuration when a consumer needs them:

- the review skill's deferral step (`defer-batch.ts`) calls Linear directly,
  with fixed label groups, instead of going through the
  [tracker interface](GLOSSARY.md);
- the drive pushes to and fetches from a remote named `origin`;
- summary-finding severity is parsed only for the reviewers whose comment
  formats the drive already knows.

### 9. Groundwork's own Simplified Technical English linter

`decide`'s `ste-lint` is a faithful TypeScript translation of a third-party
Python linter, kept output-identical to it. Rewrite it as Groundwork's own
implementation of the same writing rules, free to deviate where Groundwork's
rules differ (for example by folding in the corrections its wrapper applies
today), and keep crediting the original
([Credits](plugin/RECOMMENDED-SKILLS.md#credits)). The parity record and the
golden files from the Python linter then retire with the translation.

### 10. More tracker adapters

Jira, and a plan file kept in the repository. Both wait on the open decisions
below.

## Later

- **More skills.** `scaffolding-update` (keeps agent instruction files in step
  with decisions and audits them; M0), with its paths as configuration; and a
  SOLID-principles review skill, once its generic procedure is separated from
  the stack-specific checks it carries.
- **Tracker planning.** Epic planning, batching and prioritisation as skills on
  the tracker interface, where the procedure is generic rather than one
  organization's workflow.
- **Gates and workspace infrastructure.** The change-area resolver
  ([M3](modules/M3-change-area-catalog/README.md)), cross-worktree locks and
  test infrastructure, remote gates, and a runnable form of
  [M12](modules/M12-parallel-agent-ergonomics/README.md)'s workspace lifecycle.
- **Shared test helper.** A shell-command reachability model for testing
  workflow files, once it is separated from the workflow conventions it is
  written against.
- **Module gaps.** Items each module README lists as future: M4's tag-merge
  normalizer and scheduled wiki lint, M3's catalog-to-regex reverse check
  (needs the resolver), a semantic tier for ADR rules (M5 with M7/M8), M12's
  probe-for-free port fallback.
- **Module consistency.** M6's stage gates require `status: accepted`, which
  M4's frontmatter schema does not define (it has `approved`), and M6's
  templates lack M4's required fields: pick one vocabulary. M3's catalog keys
  tracker labels under `linear:`; rename it to a tracker-neutral key with the
  schema and fixtures. M3's two reference READMEs are correct but long and
  hedged; rewrite them to state the rules plainly.
- **Drive loop follow-ups.**
  - `drive-pr`'s CI-repair round should run `/groundwork:fix-ci`, but that
    skill commits and pushes on its own, while a drive pass must push through
    `finish-round.ts`; give `fix-ci` a mode that stops before pushing.
  - The orphan warning in `scripts/lib/state/orphans.ts` can never fire under
    the default state directory; remove it or make it look in the right
    place.
  - `references/post-fence.md` says its fence probe can go once every install
    of `resolve-review-comments` also carries `drive-pr`. The plugin ships both
    together; decide whether standalone copies still need the probe.
  - The refocus behaviour is enabled on half of `do-item`'s items as a
    comparison. Decide from its results whether it stays, becomes the
    default, or goes.
- **Standalone reference gates.** The gates in M0–M2 and M6–M9 import the
  repository's `lib/`, so a reader cannot copy one alone. Either make them
  self-contained or ship `lib/` as a documented, versioned dependency.
- **De-scarring the plugin's code comments.** About 300 comments in 59 files
  still say "an earlier change" where they should state the rule directly,
  and some tests still use bare `TASK` placeholders where an issue key was
  removed; rewrite them as their files are next touched, or in one sweep.

## Standing: backflow

Groundwork keeps learning from the repositories that use it. When one of them
finds a better gate, a corrected design or a new review lens, evaluate it for
Groundwork and port the corrected design, not the first attempt
([principle 5](principles/05-learning-loop.md)). A consumer's own values stay
in that consumer's configuration.

## Open decisions

These need a human decision before the work that depends on them starts.

- **Publishing.** Groundwork is private. The licence is chosen (item 2);
  whether and when to open the repository, whole or per module, is still a
  human decision.
- **Plan-file tracker format**: one file for the whole plan, or one per item.
- **Optional tracker operations**: whether the tracker interface's reporting
  operations may be optional for an adapter that cannot answer them.
