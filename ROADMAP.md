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

### 1. `/groundwork:audit`

The auditor as a plugin skill a repository runs again and again, not a
one-time adoption step. Today the [auditor](audit/README.md) is a method, survey
prompts and a checklist generator that an agent follows by hand from a
Groundwork checkout; a repository that installs the plugin cannot run it, and
nothing records what an earlier audit found.

What it does:

1. **Configuration fit** (mechanical, a script). Reads the repository's
   `.config/groundwork-overlay.yaml` and reports unknown or deprecated keys,
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
3. **A committed record**, `.config/groundwork-audit.yaml`: the plugin version
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

- The plugin installs only `plugin/`, but the criteria live in `modules/`. The
  skill needs them inside the plugin: either generated into the skill with a
  freshness gate, or read from a pinned Groundwork checkout. Prefer the option
  that keeps one source of truth and fails a gate when the copies differ.
- `audit/` moves into `plugin/skills/audit/` (moved, not copied), leaving a
  pointer in `audit/README.md`.
- Done when the skill audits Groundwork itself (its record committed here) and
  one external repository, as the
  [calibration run](audit/calibration/2026-07-19-execa.md) did by hand.

## Next

### 2. Delegated merge (`pull_requests.merge: auto-on-converged`)

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

### 3. Values the skills still assume

Move into configuration when a consumer needs them:

- the review skill's deferral step (`defer-batch.ts`) calls Linear directly,
  with fixed label groups, instead of going through the
  [tracker interface](GLOSSARY.md);
- the drive pushes to and fetches from a remote named `origin`;
- summary-finding severity is parsed only for the reviewers whose comment
  formats the drive already knows.

### 4. Groundwork's own Simplified Technical English linter

`decide`'s `ste-lint` is a faithful TypeScript translation of a third-party
Python linter, kept output-identical to it. Rewrite it as Groundwork's own
implementation of the same writing rules, free to deviate where Groundwork's
rules differ (for example by folding in the corrections its wrapper applies
today), and keep crediting the original
([Credits](plugin/RECOMMENDED-SKILLS.md#credits)). The parity record and the
golden files from the Python linter then retire with the translation.

### 5. More tracker adapters

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

- **Publishing and licence.** Groundwork is private and grants no licence.
  If it is opened, Apache-2.0 is the recommended licence (a patent grant,
  friendly to corporate adoption, suited to prose and code alike); publishing
  could also happen per module.
- **Plan-file tracker format**: one file for the whole plan, or one per item.
- **Optional tracker operations**: whether the tracker interface's reporting
  operations may be optional for an adapter that cannot answer them.
