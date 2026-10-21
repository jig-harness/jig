# Contributing to Jig

How a change to Jig is made, checked and merged, for people and agents
alike. [AGENTS.md](AGENTS.md) holds the rules every session needs and points
here for the detail; [docs/](docs/README.md) says how Jig's own documents are
governed; [plugin/AGENTS.md](plugin/AGENTS.md) adds the rules for anything
under `plugin/`.

**Contributing from outside the maintainers?** Read
[Outside contributions](#outside-contributions) first: it says what is
welcome and where to raise it. Work is reported on GitHub Issues, which
anyone can use. The maintainers also track their own work in an issue tracker
that outside contributors cannot see; the steps below that depend on it are
marked "maintainers", and a contributor can skip them.

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
- A pull request whose change a team using Jig would notice (always one that
  changes `plugin/`) records it as a [change note](changes/README.md) under
  `changes/`
  ([which changes get one](changes/README.md#when-a-pull-request-needs-one)),
  never as an addition to [CHANGELOG.md](CHANGELOG.md)'s Unreleased or
  release sections or a change to the plugin version. A pull request that changes `plugin/` gives its note
  `release: patch|minor|major`; after the merge, the release step writes the
  note into the changelog and moves the version, and the release commit is
  tagged once its gates pass
  ([ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md)).
  A file that must name the version a change ships in (a `since:`) names
  `next`, which the release replaces.

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
   resolved. Between rounds the drive holds CI with the `ci:hold` label
   (`ci.hold_label`, [M13's hold](modules/M13-pipeline-economy/README.md#7-hold)):
   while it is on, the `gates` check fails without running the jobs, and
   removing it runs them in full. A drive that stopped can leave the label
   behind; remove it by hand (`gh pr edit <PR> --remove-label ci:hold`),
   never by rerunning the held run.
4. The pull request may merge once a round after Ready has settled: every
   reviewer has reported on the current head, no thread or summary finding is
   left unanswered, and the required checks are green. A person merges; an
   agent never does ([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)).
5. Maintainers: after the merge, run `/followup <PR>`
   ([.claude/skills/followup/](.claude/skills/followup/SKILL.md)): the
   tracker item and deferred findings, the release tag, what the merge did
   to the website, the status pages and documents that cite them, the
   consumer repositories, and cleanup. Its fixes go in one follow-up pull
   request. A contributor's pull request owes nothing here; the maintainer
   who merges it runs this step.

## Jig's own skills

Procedures for maintaining this repository, as opposed to the ones Jig ships
to other repositories, are skills in `.claude/skills/`, the canonical skill
directory [M0](modules/M0-instruction-architecture/mappings.md#cross-runtime-skill-discovery-the-symlink-mirror)
recommends. They are not part of the plugin, so changing one ships no
version. One that opens pull requests or files issues sets
`disable-model-invocation: true`, so it runs only when a person or a schedule
starts it; the context budget gate still measures its description. The
exception is `followup`: every session is told to run it after a merge
([AGENTS.md](AGENTS.md)), so an agent must be able to start it. Their
scripts and tests live in `scripts/`, where the gates run them. Codex reads
skills from another directory; link it once per worktree with M0's mirror
script (the links are gitignored):

```sh
bun modules/M0-instruction-architecture/reference/sync-skills-mirror.ts
```

- [`followup`](.claude/skills/followup/SKILL.md): settles what a merged
  pull request still owes (step 5 above).
- [`website-update`](.claude/skills/website-update/SKILL.md): brings the
  site up to date with the commits since its last check, recorded in
  `website/content-sync.yaml`.

### Filing issues from this repository (maintainers)

This section is for Jig's maintainers, who file their work in a tracker
(Linear) that outside contributors cannot reach. A contributor opens a
[GitHub issue](https://github.com/jig-harness/jig/issues/new/choose) with the
bug or "Proposed change" template, or a
[discussion](https://github.com/jig-harness/jig/discussions) for a question or
an idea ([Outside contributions](#outside-contributions)), and needs nothing
below. A maintainer who accepts such an issue files the tracked work from it
and links the two.

`/jig:file-issue` needs a [label taxonomy](GLOSSARY.md) to check the labels
before it writes an issue. Jig's maintainers use the taxonomy in their
maintained external standards checkout; the organization's label names and
other tracker values stay outside this repository.

On each machine, make that checkout available and merge this setting into
the existing `issue_tracker` section of `$HOME/.jig/jig.yaml` (or
`$JIG_HOME/jig.yaml` when `JIG_HOME` is set):

```yaml
issue_tracker:
  taxonomy: /absolute/path/to/standards-checkout/policies/label-taxonomy.yaml
```

Use an absolute path: relative paths resolve against the repository being
worked on, and `~` in the setting is not expanded. This user setting applies
to every repository on the machine unless repository or environment
configuration overrides it. Keep the path and the organization's taxonomy
out of tracked files.

From a Jig checkout, set `plugin_dir` to the installed Jig plugin's absolute
path and check the resolved setting, the taxonomy, and the proposed labels:

```sh
plugin_dir=/absolute/path/to/installed/jig/plugin
bun "$plugin_dir/skills/resolve-review-comments/scripts/jig-config.ts" issue_tracker.taxonomy
bun "$plugin_dir/skills/file-issue/scripts/check-label-taxonomy.ts"
bun "$plugin_dir/skills/file-issue/scripts/validate-labels.ts" --check-tracker "<label>" "<another-label>"
```

Replace the label placeholders with the intended labels, quoting names that
contain spaces. The first command reports which configuration layer supplies the
path; the second checks the taxonomy without tracker access. The last also
needs credentials that can read labels in the configured tracker team.
With the Linear adapter, provide `LINEAR_API_KEY` or `LINEAR_API_TOKEN` to
the shell running the command, or sign in to the `linear` command-line
client. An agent's MCP connection alone does not authenticate this script.

On a fresh machine, finish this setup before filing. A missing or unreadable
taxonomy stops the skill before it writes; a path in user configuration
does not fetch the external checkout.

## Toolchain

Runnable tooling and gates are written in Bun + TypeScript
([ADR-0001](docs/adr/ADR-0001-bun-typescript-toolchain.md)): Bun runs
natively on macOS, Linux and Windows, where Bash runs only through a
compatibility layer and its standard utilities behave differently on macOS
and Linux. Bun is this repository's toolchain, not a requirement on consumer
repositories: tooling a non-JavaScript repository runs ships as a standalone
executable or is pinned through mise. The repository and module gates run
natively under the pinned Bun runtime. That version has one source,
`mise.toml`, which the workflows install through mise; `package.json`'s
`packageManager` field and its Bun types package repeat it,
`.config/toolchain-pins.yaml` declares them as its pin sites, and
`bun run pins` (in the gates) fails when one differs
([M2](modules/M2-generated-artifact-freshness/README.md#one-version-source)).

## Quality gates

Dogfooded [M1](modules/M1-gates-enforcement-ladder/README.md), tiny by
design. Run all with one command: `bun run gates`. The set, cheapest first:

1. the [always-loaded context](GLOSSARY.md) budget
   (`scripts/check-context-budget.ts`: M0's instruction-chain and
   skill-description budgets, which CI also runs before installing
   dependencies);
2. format, lint (Biome, with Jig's GritQL rules in `tools/quality/grit/`),
   types (`bun check`);
3. the repository checks (`CHECKS` in `scripts/gates.ts`): the supply-chain
   policy lockstep (`scripts/check-supply-chain-lockstep.ts`: `bunfig.toml`,
   `package.json`, `website/bunfig.toml`, `website/package.json` and
   `renovate.json5` state `.config/supply-chain-policy.yaml`, which CI also
   runs before installing dependencies); Markdown links
   and the paths the `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` files
   name resolve; a blank line before every table; terms of art defined in the
   glossary (acronym proxy; escape hatch: `scripts/glossary-allowlist.txt`,
   each entry under a reason and removed once nothing uses it);
   no origin references; plugin code reaching Linear only through the
   tracker interface (`scripts/check-tracker-boundary.ts`, with the files
   that still bypass it, each under its reason, in
   `scripts/tracker-boundary-allow.txt`); the licence files and NOTICE complete
   (`scripts/check-licences.ts`); no workflow that runs a fork's code with
   secrets (M7's PR-target safety lint); the workflows meeting M13's pipeline
   conventions (the workflow-convention lint, with its heavy suites in
   `.config/workflow-conventions.yaml` and its reasoned exceptions in
   `.config/workflow-conventions-exceptions.txt`); every scheduled workflow
   declared with its cadence in `.config/scheduled-jobs.yaml` (M11's
   heartbeat coverage check); the delivery lifecycle map
   (`scripts/check-lifecycle-map.ts`, M6's lifecycle map gate over
   `docs/LIFECYCLE.md`: every owner it names exists, every plugin skill is on
   it, `AGENTS.md` links it, and no document names a `/jig:` skill that does
   not exist); a changelog section for
   the current plugin version, change notes the release step can read, and a
   branch that leaves the changelog's open sections and the version to that
   step (with a note asking for a release when it changes `plugin/`); Jig's
   own audit record and configuration fitting the audit skill; every file
   belonging to an area of the change-area catalog
   (`.config/change-areas.yaml`); every derived file the catalog declares
   fresh, through M2's runner (`scripts/check-generated-files.ts`, see
   § Derived files); the AI reviewer's high-risk paths
   matching the catalog's `reviewRisk: high` areas
   (`bun scripts/review-risk.ts --write` regenerates them); and every
   ROADMAP.md item in `design/plan.md` in the same group and order
   (`scripts/check-roadmap.ts`);
4. unused code, and the changed files' complexity and duplication (fallow);
5. the ratchet (below);
6. gate self-tests, the plugin hook's tests among them, then build.

Steps 1 to 3 take seconds and run before the minutes the tests and build
take, so a broken link is reported at the start of a run, not after the
suite. The stages are independent, so a failing one does not end the run:
every stage reports, the run closes with the list of what failed, each line
the command that reruns that stage alone, and it exits 1 when a stage found
violations and 2 when the only failures are stages that could not check.
Two unrelated failures surface in one run rather than two; fix every stage
the list names, not only the first.

The repository test command uses 4 parallel file workers. Many suites spawn
their own subprocesses; bounding file workers keeps those fixtures within
their deadlines when several workspaces run checks on one machine.

CI runs the same command on Linux for every pull request
(`.github/workflows/gates.yml`); the catalog decides which of its jobs and
steps a pull request needs. macOS and Windows run once a day against `main`
(`.github/workflows/nightly.yml`), and on demand from the Actions tab for a
branch likely to break on one of them. A new top-level file or directory gets an area in the catalog
in the same pull request.

Scope differs per gate, and each check script's header comment states exactly
what it skips and why: the Markdown gates leave vendored material (`seeds/`),
`templates/` and test `fixtures/` out, while the origin-reference gate covers
everything, vendored material and templates included, except test `fixtures/`
and its own pattern file.

`main`'s ruleset requires a pull request with the `gates` check green and
every review thread resolved, and forbids force-pushes and deleting the
branch. It requires nothing more: no approving review (a person merges) and
no up-to-date branch, which would cost a pull, a push and a full CI run on
every open pull request at each merge. Only the `jig-release` GitHub App,
which pushes the release commit after a merge
([ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md)),
and repository administrators may bypass it.
The intended policy lives in `.config/external-preconditions.yaml`.
`.github/workflows/external-preconditions.yml` checks it daily under the
release App identity with a token limited to Contents read and Administration
read, minted in a job that runs nothing from the repository and hands what it
read to a keyless job that judges it. This scope can inspect classic protection; GitHub withholds ruleset
bypass actors unless the caller has write access to the ruleset. A complete
bot-bypass observation therefore needs an explicitly approved Administration-
write observer token, still used only for read requests. Until then the
read-scoped observation reports bypass as unknown. A separate workflow token
maintains one GitHub issue while the registry
is unresolved and closes it after recovery; only an issue that token's
identity opened is ever adopted. The App installation must grant
Administration read before the observation can inspect protection; unavailable
credentials and withheld bypass lists fail closed. The registry also checks
that the App can push release commits while history remains protected for it.
`bun scripts/check-branch-protection.ts` remains a manual compatibility report
of the branch controls, using the same registry policy; it requires a `gh`
login permitted to inspect protection. This repository's ruleset also requires
the AI reviewer's check, beyond that policy.

After the observer workflow merges, dispatch its current main version with
`gh workflow run external-preconditions.yml --ref main` and inspect the run
under the release App identity. A local administrator's green result does not
establish the App's access. The workflow never repairs host settings.

Locally, `JIG_GATES_SKIP_SEPARATE_SUITES=1 bun run gates` leaves out the long
drive-pr suite and the website's tests, which CI runs in the drive-pr job and
in the gate-set job's website steps; run
the test files for what you changed, and let CI run the rest. The website's
tests need `bun install` inside `website/` first.

### Where Jig's gates fall short

Measured against [M1](modules/M1-gates-enforcement-ladder/README.md)'s rules
for a gate, Jig's repository checks (`CHECKS` in [`scripts/gates.ts`](scripts/gates.ts))
and its ratchet (in CI; locally see the table below) exit 2 when they could
not check, state their scope on green
runs; the change-area and review-risk checks fail on a repeated key in the
YAML they read. The Markdown, glossary,
origin-reference and workflow-convention checks also write findings in the
shared format with GitHub annotations, and their exception lists
(`scripts/glossary-allowlist.txt`, the allow patterns in
`scripts/tracker-key-patterns.txt`, `.config/workflow-conventions-exceptions.txt`)
need a reason per group and fail on an entry that suppresses nothing. Where a gate does not yet
meet a rule:

| Gate | Rule not yet met | Why |
|------|------------------|-----|
| `check-licences`, `check-changelog`, `check-audit-fit`, `change-areas --check`, `review-risk --check`, `check-workflow-safety` | Findings name no rule and are not annotated in CI | Their messages already name the file and the fix in prose; moving them to the shared format is open work |
| `check-instruction-paths` | Findings name no rule or fix | It reports through M2's referenced-paths check, whose output format belongs to M2 |
| `check-schedules-declared` | Findings name no rule and no file or line, and are not annotated in CI | It reports through M11's heartbeat check (`UNDECLARED <id> …`), whose output format belongs to M11 |
| The ratchet (`bun run quality`) | A missing merge base passes locally, reported as skipped | So the pre-push hook works in a shallow clone; CI, the authority, exits 2 |
| Unused code (`bun run deadcode`, fallow) | Entry points are declared by folder pattern in `.fallowrc.jsonc` (the scripts, tools, skill scripts and reference gates folders) rather than file by file | Those folders hold the scripts a hook, CI, a skill or a reader runs by path; listing each from its invocation is open work |

### Jig's own supply chain

Jig states its policy in `.config/supply-chain-policy.yaml` (a cooldown of
3 days, no exemption, no package allowed to run install scripts) and holds
`renovate.json5` and the `bunfig.toml` and `package.json` of each install
root (the repository's and the website's) to it with
`scripts/check-supply-chain-lockstep.ts`, the first of the repository checks
in `bun run gates` and a step of CI's gates job before the install, so a
change to the allowlist is judged before any script could run. CI then
installs with scripts off (`bun install --ignore-scripts`) in every
install root, so no dependency's script runs there at all. A developer's
install goes by `trustedDependencies`, which each `package.json` sets to
the empty list: set, even empty, it replaces Bun's built-in list of trusted
packages, so no dependency's script runs there either. `bun pm untrusted`
shows whether an installed package has a script the list blocks, and a
dependency that needs its script run is added to the policy and to
`package.json` together. Jig has no secret scan of its
own yet (no pre-commit hook, no CI scan, and push protection is a host
setting): adding those layers to Jig is future work.

### The ratchet

`bun run quality` (M1's [ratchet gate](modules/M1-gates-enforcement-ladder/reference/ratchet/README.md))
fails a change that adds a finding to a rule at `warn` in `biome.json`, to a
flag in `tsconfig.ratchet.json`, a suppression comment, or the total source
lines above the 1000-line limit per file, measured against the merge base.
The size counter covers source and test code, including website
styles and templates; it excludes fixtures, seeds, vendored code and build
outputs. Split by responsibility at the source. Do not pad the exclusion
list or raise the limit to pass. Untracked source files enter the comparison
unless Git ignores them. Fix the finding; do not suppress it. It also fails a change
that loosens a rule, unless a commit carries
`Ratchet-Loosen: <name>: <reason>` in its last paragraph. Never add that
trailer on your own initiative: only when a person has asked for that
loosening, and say so in the pull request. When the gate reports a lint or compiler rule at
zero, promote it to `error` (or move the flag into `tsconfig.json`). Keep
the source-size counter active at zero so that any excess line fails.

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
them. Each of Jig's is declared once, as a `generated:` entry of the area
that owns it in the change-area catalog (`.config/change-areas.yaml`, M3):
its outputs, its source, the command that regenerates it and the check that
fails when it is stale, with its limits in `notes`. That is M2's
[generated-file inventory](GLOSSARY.md), and `bun run gates` runs every
declared check through M2's generic runner
(`modules/M2-generated-artifact-freshness/reference/inventory/`, called by
`scripts/check-generated-files.ts`), so a derived file cannot be added without
its check, a failing check names the regenerate command, and every check runs
whatever the earlier ones found. To see them:

```sh
bun modules/M2-generated-artifact-freshness/reference/inventory/run-generated-checks.ts --list .config/change-areas.yaml
```

The example indexes open with a "generated" header naming their generator.
The lockfiles and the vendored parsers cannot carry one, since each must stay
byte for byte what its generator writes, so their entry is their marker.

A new derived file gets its entry in the pull request that adds it; the
runner refuses an entry without a check.

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
`modules/*/templates/` and `plugin/skills/*/templates/` are under MIT No Attribution
([LICENSE-MIT-0](LICENSE-MIT-0)). [NOTICE](NOTICE) names the licensor, lists
those template files one by one, and lists the third-party code the plugin
vendors with the licence file beside each. A new template gets its line in
NOTICE, and vendored code arrives with its licence file and a NOTICE entry;
`scripts/check-licences.ts` in the gates fails until they do.

## Outside contributions

Jig has one maintainer, who decides what goes in
([GOVERNANCE.md](GOVERNANCE.md)), and the rules in [AGENTS.md](AGENTS.md)
decide most of it before anyone reads a diff: Jig states general patterns,
keeps an organization's values in that organization's configuration, and
brings in nothing a working repository has not validated. Within those
rules:

- **Welcome as a pull request, no issue first:** a row in a module's
  `mappings.md` for another ecosystem; an adapter behind an interface that
  already exists (an issue tracker, a reflection store, a launcher
  provider); a bug fix with a test that fails without it; a correction to
  text or a link; an audit criterion's probe made more precise.
- **Open a GitHub issue first** (the "Proposed change" template): a new
  module, criterion or skill; a change to an invariant a module states; a
  change under `plugin/` beyond a fix, since it ships to every machine; a new
  run-time dependency; a change to a gate's policy. Bugs use the "Bug"
  template; questions and ideas that are not yet work go to
  [Discussions](https://github.com/jig-harness/jig/discussions). Anything
  that must stay private, a vulnerability or a conduct report above all,
  never goes in a public issue: use the repository's private report form
  (Security, then "Report a vulnerability"), as [SECURITY.md](SECURITY.md)
  and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) describe. Outside
  contributors file no other kind of issue.
- **Not taken:** material that names or copies an organization's own
  repository, keys or values; a practice no repository has run; a rewrite
  of a document or a skill; and a large unsolicited pull request, which is
  closed with a pointer to this section.
- **Larger than a fix?** A tool that speaks one of Jig's command
  contracts, such as a reflection store, a validation-plan command or a
  classify command ([plugin/EXTENDING.md](plugin/EXTENDING.md)), lives in
  its own repository and Jig points to it; that is the normal way in. An
  adapter that runs inside the plugin, such as an issue tracker's, is a
  pull request to Jig.

A contribution is accepted under the project's licence: sign off each
commit (`git commit -s`), which adds a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/), that
you wrote the change or otherwise have the right to submit it. This
applies to a contribution from outside the maintainers; a maintainer's
own commits are covered by their role. No automated check enforces it:
the maintainer who merges a pull request from outside checks that every
commit carries the line, and does not merge until it does. No
contributor licence agreement is asked for. Keep issue-tracker keys and
links to private systems out of commit messages: a pull request description
may link an issue; a commit message is history that anyone reads.

A pull request from a fork runs the gates once a maintainer approves the
workflow run. The AI reviewer reads only pull requests whose branch is in
this repository, and a branch pushed here runs its workflows with this
repository's own token. So a maintainer first reads the whole change, its
workflows and anything the gates run above all; then pushes the branch here,
with the contributor's commits and sign-off as they are, and opens the pull
request from it. That pull request carries the review and the merge, and the
fork's closes with a link to it. A maintainer's own pull requests get both
without a step. Pull requests open as drafts and are driven to convergence
the same way ([§ Pull-request lifecycle](#pull-request-lifecycle)); a
contributor without the plugin drives the review by hand, one round at a
time.

## Adding or changing a plugin skill

A skill moves into `plugin/skills/` under the rules in [AGENTS.md](AGENTS.md)
(move, never copy; the consumer's own values stay in the consumer). For it to
work as part of the plugin:

- **Location:** `plugin/skills/<name>/SKILL.md`, with `name: <name>` in its
  frontmatter. Supporting files sit beside it (`scripts/`, `references/`).
  Code more than one skill uses lives in `plugin/shared/` and is imported by
  relative path ([plugin/AGENTS.md](plugin/AGENTS.md)).
- **Assets from a module:** a template or a gate the skill uses moves in from
  its module, never copied: templates to `templates/`, gates to `scripts/`
  with their self-tests in `__tests__/` and no import of the repository's
  `lib/`. The module's README links them in the skill, and the skill's
  README links back ([modules/AGENTS.md](modules/AGENTS.md#the-module-contract)).
  A template gets its line in [NOTICE](NOTICE), and `cp NOTICE plugin/`.
- **Paths:** reach your own files as `${CLAUDE_SKILL_DIR}/…` in `SKILL.md`, and
  explain the placeholder once for other tools, as
  [resolve-review-comments](plugin/skills/resolve-review-comments/SKILL.md#paths-and-working-directory)
  does. Reference files are not substituted; write `<skill-dir>/…` there.
  Never write a path into the consumer repository such as
  `.claude/skills/<name>/…` for your own files.
- **Working directory:** scripts run with the consumer repository as the
  working directory and must not depend on being run from the skill directory.
- **Commands:** skill instructions use single-line `bun` invocations with
  plain arguments, so the same command works in Bash and PowerShell. Move
  composition into the script and take generated input from a file. For a
  direct program call with file input or output, use
  `plugin/shared/command.ts`; it passes an argument array with a deadline.
  `scripts/check-skill-shell-neutrality.ts` checks executable examples and
  composed inline commands across skill instructions and reference pages.
- **Consumer values:** read them at run time through
  `plugin/shared/consumer.ts` (`readConfig`, or
  `readOverlay` where the skill requires an adopted repository), which merges
  every [configuration layer](plugin/CONFIGURATION.md#configuration-layers); never
  parse `.config/jig.yaml` directly, or the user file and the environment are
  silently skipped. A procedure whose agent reads a value itself tells it to
  run `plugin/skills/resolve-review-comments/scripts/jig-config.ts <field>`,
  reached from the skill by its sibling path, not to open the file. Fail with a clear message when a required value is
  missing, and accept older files. Never bake a repository's values into
  `SKILL.md`.
- **Dependencies:** the plugin cache has no `node_modules`. Use Bun's
  built-ins (its own APIs and the `node:` modules it provides), or vendor a dependency's own single-file build beside the script
  with its licence and a test that keeps it identical to the pinned package
  (as `plugin/shared/vendor/js-yaml.mjs` is).
- **Windows cancellation:** follow the scope and reconsideration conditions
  in [ADR-0008](docs/adr/ADR-0008-windows-cancellation-uses-captured-process-identities.md)
  when changing process launch, cancellation or the evidence that a
  cancellation completed.
- **Description:** keep the frontmatter `description` (and an agent's) at 512
  characters or fewer; 1,024 is the hard limit. Every repository that installs
  the plugin pays for it in every session, so
  [scripts/check-context-budget.ts](scripts/check-context-budget.ts) fails
  `bun run gates` and CI past 512, and checks the plugin's whole skill listing
  against its budget ([M0](modules/M0-instruction-architecture/reference/context-budget/README.md)).
- **Harness frontmatter:** fields only one tool reads (Claude Code's
  `allowed-tools`, `argument-hint`) are ignored by the other.
- **Tests:** keep the skill's tests in `plugin/skills/<name>/__tests__/`; extend
  `tools/plugin/plugin.test.ts` when the skill reads consumer files. A suite
  that can only run on a POSIX system is listed in `POSIX_ONLY_SUITES` in
  [scripts/gates.ts](scripts/gates.ts), with the reason, so Windows CI
  leaves it out; a suite too long for the gate job goes in `SEPARATE_SUITES`
  and gets its own sharded job in
  [the gates workflow](.github/workflows/gates.yml) and
  [the nightly workflow](.github/workflows/nightly.yml), which also runs it on
  Windows. A test that runs on Windows stands in for `gh`, `git` or `claude`
  with `writeFakeProgram` from
  [lib/test-helpers/fake-program.ts](lib/test-helpers/fake-program.ts), runs a
  script with `scriptArgv` from
  [lib/test-helpers/script-argv.ts](lib/test-helpers/script-argv.ts), and
  extends `PATH` with `path.delimiter`. A test that cannot pass on Windows yet
  skips with `skipsOnWindows` from
  [lib/test-helpers/windows-skip.ts](lib/test-helpers/windows-skip.ts), which
  names the piece of Windows work (listed in
  [design/plan.md](design/plan.md)) that lifts the skip. Any other branch on
  Windows in those suites goes through the same file and says why:
  `exceptOnWindows(reason, check)` for an assertion only a POSIX system can
  enforce, and `byPlatform(reason, { windows, posix })` for a value that
  differs. Both work only inside a running test, so neither can skip one, and
  a test that calls either must assert something on the platform it runs on:
  a test whose every check is POSIX-only, or that returns before asserting
  anything, fails. A test in
  [windows-skip.test.ts](lib/test-helpers/windows-skip.test.ts) refuses
  every other `===`, `!==` or `case` comparison with `"win32"` in those
  suites, comments and parentheses included; a platform check written
  another way, such as `["win32"].includes(process.platform)`, is for review
  to catch.
- **Agents:** put them in `plugin/agents/<name>.md` with `name: <name>` in
  the frontmatter. Claude Code loads that folder without a manifest entry;
  do not add an `agents` key to the manifest, which would replace the
  folder scan. Leave the model unpinned so the agent runs on the session's
  model.

[tools/plugin/plugin.test.ts](tools/plugin/plugin.test.ts) checks both
manifests and marketplaces, copies the whole `plugin/` directory outside this
repository the way a plugin cache holds it, checks that every import resolves
inside that copy, and runs the scripts from it against a scratch consumer
repository.

## Releasing the plugin

This repository is the `jig` plugin: both agent tools install `plugin/`,
from the [release channels](GLOSSARY.md) built out of each version's tag
([ADR-0002](docs/adr/ADR-0002-the-plugin-is-its-directory.md),
[plugin/README.md § Release channels](plugin/README.md#release-channels)). The
rules for changing anything under `plugin/` (running from a copy outside this
repository, the version bump, the release tag) are in
[plugin/AGENTS.md](plugin/AGENTS.md).

A release goes like this:

1. In the pull request that changes `plugin/`, add a
   [change note](changes/README.md) under `changes/`: what changed, and
   for a breaking change what a consumer must change first, with
   `release: patch`, `minor` or `major` as
   [semantic versioning](https://semver.org) names it. Before 1.0.0, a change
   that needs consumers to edit their configuration or instructions asks for
   `minor`; from 1.0.0, `major`. Leave the manifests' `version` and
   CHANGELOG.md alone (`bun run gates` fails otherwise, and fails a change to
   `plugin/` without a note that asks for a release). A `since:` the change
   adds names `next`.
2. Merge it with green gates.
3. The release workflow (`.github/workflows/release.yml`) then runs the
   `changelog` skill's release step on main, through the skill's action from
   this checkout (`./plugin/skills/changelog`), so Jig releases with the
   version being changed: it moves `version` in both manifests to the next
   version, writes the note as that version's section of
   [CHANGELOG.md](CHANGELOG.md), replaces `since: next` and deletes the note,
   in a job that holds no key; a second job pushes that commit to main.
4. The release commit runs the gates like any push to main. Once `gates`
   passes on that commit, the workflow's `tag-plan` and `tag-push` jobs tag it
   `v<version>`. They run after every gates run on main and every six hours;
   a cancelled gates run is run again once, and a release commit whose gates
   failed stays untagged, fails `tag-plan` and shows in the changelog skill's
   `status.ts`, for a person to fix.
5. The workflow's `latest` job then moves the `latest` channel to the newest
   tagged version (`.github/workflows/channels.yml`, running
   `tools/plugin/channel.ts`). Each run catches up, so a version a failed run
   left behind arrives with the next one.
6. A maintainer promotes a version to `stable` once it has proven itself on
   `latest`, and rolls `stable` back when a promoted version turns out bad:

   ```sh
   bun tools/plugin/channel.ts status          # each channel, and what latest has that stable lacks
   bun tools/plugin/channel.ts check 0.62.0    # the promotion rule's verdict, read-only
   gh workflow run channels.yml --repo jig-harness/jig -f command=promote -f version=0.62.0
   gh workflow run channels.yml --repo jig-harness/jig -f command=rollback -f version=0.61.1
   ```

   The run refuses, naming each reason, unless the rule in
   [plugin/README.md § Release channels](plugin/README.md#release-channels)
   holds. `channel.ts` reads the tags and channels from the `origin` remote, so
   run it in a clone of this repository, not of a fork. A bug report that says a version broke something that worked
   before gets the `regression` label when it is triaged, with the version it
   was found in in its "Plugin version" field: while it is open, no promotion
   that would bring that version to `stable` runs. A rollback across a breaking release needs
   `-f across-breaking=true`, which applies to a rollback only. One `stable` request runs at a time; a second
   one made while another waits replaces it.

The workflows push, tag and move the channels as the `jig-release` GitHub
App, the one actor `main`'s ruleset lets past its pull-request and check
rules, and the one the channels' ruleset lets create or update `latest` and
`stable`; its client ID
(`RELEASE_APP_CLIENT_ID`) and private key (`RELEASE_APP_PRIVATE_KEY`) live in
the `release` environment, which only `main` may use. The jobs that push and
tag run nothing from the repository. The external-precondition observer also
uses that environment, loads its code from current main and mints a separate
read-only token of the same App; it changes no host settings. When the
workflow cannot push (the App was uninstalled, its key revoked, or the ruleset
no longer names it), the notes wait on `main` and nothing is lost: restore it,
then run the workflow by hand (`gh workflow run release.yml`, or Run
workflow on its Actions page). It writes every waiting note as one release.
`bun scripts/release.ts --dry-run` shows locally what the next run writes. A release cannot go through a pull request instead: the gates refuse a
branch that moves the version or writes a release section, which only the
release step may.

Machines receive the release on their next update. Repositories need no change
unless the changelog says so.
