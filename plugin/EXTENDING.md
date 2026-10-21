# Extending and adapting Jig

A team that adopts Jig rarely uses exactly the tools Jig's tooling is bound
to today. Without a map of what can change, it finds out by trial: it sets a
field that does not exist, writes a wrapper around a skill that already
takes a command, or discovers halfway through a drive that its forge, its
issue tracker or its operating system is not supported. This document is
that map. It says which parts of Jig a repository adapts with a value,
which with a command of its own, which need an implementation added to Jig,
and which are fixed today, with the [roadmap](https://github.com/jig-harness/jig/blob/main/ROADMAP.md) item that
would open each one.

Every field it names that exists today is in the
[configuration reference](CONFIGURATION.md). What a machine needs is in the plugin's [requirements](README.md#requirements).

Contents: [ways to adapt](#ways-to-adapt-jig) ·
[at a glance](#at-a-glance) ·
[commands a repository supplies](#commands-a-repository-supplies) ·
[the repository's own skills and agents](#the-repositorys-own-skills-and-agents) ·
[issue tracker](#issue-tracker) · [reflection stores](#reflection-stores) ·
[AI reviewers](#ai-reviewers) · [forge](#forge-github) ·
[CI system](#ci-system) · [agent tools](#agent-tools) ·
[workspace launcher](#workspace-launcher) ·
[operating systems](#operating-systems) ·
[practice mappings](#practice-mappings) ·
[contributing an extension](#contributing-an-extension)

## Ways to adapt Jig

From least to most work:

1. **Set a value.** Labels, team keys, branch patterns, reviewer names, file
   locations: the repository writes them in `.config/jig.yaml`, a person in
   `~/.jig/jig.yaml`, one run in an environment variable
   ([configuration layers](CONFIGURATION.md#configuration-layers)). Many
   values need no field at all, because Jig reads them from the repository
   ([what is derived](CONFIGURATION.md#what-is-derived-not-declared)).
2. **Supply a command.** Where the work is the repository's own (its checks,
   its generators, its lints), a skill runs a command the configuration
   names, under a fixed contract: what it receives, what it prints, what its
   exit code means. Any language, any tool; nothing in Jig changes
   ([below](#commands-a-repository-supplies)).
3. **Add an implementation behind an interface.** Where Jig talks to an
   outside service (an issue tracker, a workspace app), it does so through
   an interface with one implementation per service, chosen by a field. A
   new service is a new implementation, added to Jig by pull request, so
   every repository that uses that service shares one maintained copy.
4. **Add to the doctrine.** Each module's `mappings.md` names the tools that
   implement its practice in each ecosystem. A tool missing there is a new
   row ([below](#practice-mappings)).

What a repository should not do is copy a skill to change it: the copy stops
receiving fixes the moment it is made. When none of these fits, the gap
is Jig's: [contribute](#contributing-an-extension) the field, the command
hook or the interface instead.

## At a glance

| Concern | Supported today | Adapt it by | Fixed today, open in |
| --- | --- | --- | --- |
| Local checks, generators, lints | Any command | [A command](#commands-a-repository-supplies) | — |
| Review skills, implementing agents, scouts | The repository's own | [Configuration](#the-repositorys-own-skills-and-agents) | — |
| Issue tracker | Linear | [A tracker adapter](#issue-tracker) in Jig | The deferral step and a few operations still call Linear directly: roadmap items 10 and 12 |
| Reflection store | A folder of files, a Notion database, or any command | [A store command](#reflection-stores), no change to Jig | Jira: roadmap, later |
| AI reviewer | Any bot, by login, app and check name; finding severities from CodeRabbit, Greptile, the Codex connector, Jig's own finding format, or any reviewer [configured](#severity-formats) | [Configuration](#ai-reviewers) | — |
| Forge (where pull requests live) | GitHub, through the `gh` command | — | [No forge interface yet](#forge-github): roadmap, later |
| CI system | Any CI that reports checks to GitHub | `ci.required_checks`; `fix-ci --log` | [Log download and workflow review](#ci-system) are GitHub Actions only |
| Git remote | `origin` | — | Roadmap item 10 |
| Agent tool | Claude Code, Codex | [Copying the skills](#agent-tools) for any other | — |
| Workspace launcher | Linear and Conductor, on macOS | [A provider](#workspace-launcher) in Jig | Herdr provider, the primary target: roadmap item 19 |
| Operating system | macOS and Linux; Windows for most skills | — | [`drive-pr`, `do-item` and the launcher](#operating-systems) |
| The repository's language and stack | Any | Practice mappings; Bun runs Jig's tools only | — |

## Commands a repository supplies

Each of these is a field whose value is a shell command. The skill runs it
from the repository root and judges it by its exit code: 0 is success. The
contract column says what else the command is given or must print.

| Field | Run by | Contract |
| --- | --- | --- |
| `gates.command` | resolve-review-comments, drive-pr, fix-ci, resolve-conflicts, descar | The repository's complete local checks, run before every push |
| `drive.validation_plan_command` | drive-pr, and the skills that verify a change | Reads the changed files, one per line, on standard input; prints the validation plan as JSON ([format](skills/drive-pr/README.md)) |
| `drive.load_guard_command` | drive-pr | Returns once the machine can take heavy checks |
| `descar.lint_command` | descar | Takes document paths; finds review scars in them |
| `promote_memory.lint_command` | promote-memory | `{dir}` and `{file}` stand for the memory folder and file; checks one memory against the repository |
| `fix_ci.regenerate_commands` | fix-ci | Each regenerates committed generated files a CI check compares |
| `resolve_conflicts.generated[].command` | resolve-conflicts | Rebuilds the files its `paths` match when they conflict |
| `explain.figure_build_command` | explain | Builds one explainer figure; the figure's stem is appended |
| `code_stats.classify_command` | code-stats | Reads every tracked path, one per line, on standard input; prints one JSON object per line, `{"path", "area"?, "kind"?, "language"?, "module"?}`, whose values override the skill's own classification ([contract](skills/code-stats/README.md#the-classify-command)). Exit 0 within 300 seconds; any other exit, or a line it cannot use, fails the report |

`issue_tracker.file_command` is different: no skill runs it. It is an
instruction that `do-item`, `decide` and others hand to the agent, saying how
to file an issue by hand, so it may be a slash command, and its exit code is
not checked.

The drive's pass is a command too: whatever follows `--` in its
[start command](skills/drive-pr/README.md#how-to-start-it) replaces the
default `claude -p`, which is how a drive runs on Codex or behind a wrapper.

## The repository's own skills and agents

Jig's skills hand parts of their work to the repository's own procedures,
named in configuration:

- **Review gates.** `do_item.gates` names a review skill that must approve a
  change before it is pushed, when the issue carries one of its labels or the
  change touches one of its paths. A change area in the
  [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) names the review skills its changes
  need the same way.
- **Implementing agents and scouts.** `do_item.agents` routes an issue to one
  of the repository's own subagents by change area, label or title, and
  `do_item.scouts` names the scouts that run before each.
- **Rulings.** `decide.architect_agent` names the subagent that rules on a
  dilemma; `decide.policy_files` and `decide.rules_directory` name where the
  repository keeps its standing policy.
- **Decision rules.** `adr.rules_file` holds the machine-readable rules
  `review` checks a change against.

## Issue tracker

**Interface.** The skills reach the tracker through the
[tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), defined in
[`do-item/scripts/lib/tracker/port.ts`](skills/do-item/scripts/lib/tracker/port.ts):
read an issue with its comments and children, move it to a workflow state,
comment, file an issue, change its fields and labels, search this team's
issues, read and add relations between issues, list the labels an issue can
carry, and the reads that delivery metrics and batch proposals need. Labels
and projects are given by name and a parent by its key; the adapter resolves
each to exactly one tracker resource or refuses before writing. A skill's
procedure runs the issue operations as commands of
[`do-item/scripts/tracker.ts`](skills/do-item/scripts/tracker.ts). States
are named by canonical keys (`in_progress`, `in_review`, …) that
`issue_tracker.states` maps to the tracker's own names.

**Implementations.** Linear
([`linear.ts`](skills/do-item/scripts/lib/tracker/linear.ts)), the default
for `issue_tracker.adapter`. It reads `LINEAR_API_KEY` or
`LINEAR_API_TOKEN`, or uses a signed-in `linear` command.

**To add one.** Implement the `Tracker` interface in a module beside
`linear.ts`, register it in `ADAPTERS` in
[`index.ts`](skills/do-item/scripts/lib/tracker/index.ts), add its name to
`issue_tracker.adapter`'s values in the audit's
[configuration schema](skills/audit/config-schema.yaml) and in
[CONFIGURATION.md](CONFIGURATION.md#issue_tracker), and test it as
`tracker.test.ts` tests the Linear adapter, against a fake of the tracker's
interface. Callers do not change. The interface's vocabulary was shaped
by Linear, so an adapter maps its tracker onto it:

- issue keys are `<TEAM>-<number>`, with the team from `issue_tracker.team`;
- priority is a number from 0 (none) to 4 (low);
- relations are directed and read from each issue's side: `relate A blocks
  B` makes B wait for A, and B reads it as `blocked_by` A; `relate A
  duplicate B` records A as the duplicate of B (the tracker may close A),
  and B reads it as `duplicated_by` A; `related` has no direction;
- a finished issue's workflow state belongs to one of the closed categories
  the metrics count (completed, canceled, duplicate); active states such as
  `in_progress` and `in_review` belong to none of them.

A tracker whose identifiers have no team part (GitHub Issues' `#123`) needs
the key format opened up first.

**What still assumes Linear.** These bypass the interface today, so a
second adapter does not yet reach them:

- **Deferring review findings.** `resolve-review-comments` files deferred
  findings through its own Linear client (`defer-batch.ts`), with fixed type
  and repository label groups.
- **Operations the interface does not have.** Attaching a file. Where a
  skill needs it (`decide` and `explain` attaching a sheet), its
  instructions name the Linear MCP tools or the `linear` command.
- **Skill instructions not yet moved.** `decide` escalating and `do-item`
  where no script covers a step still name the Linear MCP tools in their
  instructions, though the interface now has the operations.
- **Response shapes.** `do-item`'s parent-status reconciliation reads the
  shape of Linear's own answers.
- **Names.** The review-triage file's `severity_mapping.<severity>.linear_priority`;
  `fractal-metrics.ts --skip-linear`; the change-area catalog still accepts
  the older `linear:` block beside `tracker:`.
- **The launcher**, which has a tracker interface of its own
  ([below](#workspace-launcher)).

A repository gate (`scripts/check-tracker-boundary.ts` in Jig's own
repository) keeps the rest of the plugin's code, and the planning skills'
procedures, from reaching Linear except through the interface; the deferral
step is the one file it still allows.

Fixing it means adding file attachment to the interface, moving the
deferral step and the skills' instructions onto it, and renaming the
Linear-named fields with their old names still read. Roadmap item 10 holds
the deferral step and the names; item 12 holds the next
adapters (Jira, and a plan file kept in the repository), behind open
decisions: the plan file's format, and whether an adapter may leave out the
reporting operations.

## Reflection stores

Session reflection keeps its findings in a store that every repository on a
machine, or a whole team, writes to
([the store contract](skills/reflect/README.md#the-store-contract)). Unlike the tracker, a store is a command, not code inside Jig:

- **The contract.** The store command takes an operation (`check`,
  `append`, `list`, `diagnose`) as its first argument, reads JSON or
  [JSONL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) on standard input, writes it on standard output,
  and exits 0 (done), 1 (failed), 2 (usage) or 3 (unavailable).
- **The stores.** `filesystem`, a folder of files and the default;
  `notion`, a Notion database people browse and filter; and `command`, any
  command that keeps the contract. A Jira store is planned for later.
- **To add one.** Write a command in any language that keeps the contract,
  run the conformance suite (`store-contract.ts`) against it, and choose it
  with `reflection.store: command` and `reflection.command`
  ([fields](CONFIGURATION.md#reflection)). A store needs no change to Jig;
  one many teams want can still be contributed as a built-in.

## AI reviewers

Which reviewers the review loop works with is configuration: `review.bots`
lists the logins whose threads it resolves, and `review.reviewer_app`,
`review.reviewer_check_pattern`, `review.sticky_marker` and
`review.reviewed_sha_marker` tell the drive which check run and summary
comment are the reviewer's evidence ([fields](CONFIGURATION.md#review)). The
drive expects a reviewer only where `review.reviewer_app` or
`review.reviewer_check_pattern` is set; a repository with neither converges on
threads and CI alone.

### Severity formats

In late rounds the review loop can decline a finding it would otherwise fix
([the decline ladder](skills/resolve-review-comments/references/triage-rubric.md#the-decline-ladder)),
and how far it may go depends on the finding's severity. Each reviewer writes
severity its own way, so Jig reads it through a **severity format**: the
reviewer's login, the shape of the field, and how the reviewer's words map
onto Jig's `blocker`, `high`, `medium` and `low`. A format is read only from
comments its own login posted, so prose that happens to look like a severity
field, from anyone else, is never read as one. A finding no format reads has
an unknown severity. Where the repository's
[review-triage file](CONFIGURATION.md#the-review-triage-file) lists
`severity` under `fail_open.inert_when_unknown`, the ladder then stays inert
for that finding; where it does not, the severity clause abstains and the
ladder's other clauses decide.

Built in, each checked against the reviewer's real comments:

| Reviewer | Login | Shape | Words |
| --- | --- | --- | --- |
| CodeRabbit | `coderabbitai` | `pipe-fields`: `**🔒 Security** \| **🟠 Major** \| **⚡ Quick win**` | `Critical` blocker, `Major` high, `Minor` and `Trivial` low |
| Greptile | `greptile-apps` | `html-badge`: an `<img alt="P1">` badge at the head of the finding | `P0` blocker, `P1` high, `P2` medium |
| Codex connector | `chatgpt-codex-connector` | `badge`: a `![P1 Badge]` image at the head of the finding | `P0` to `P3`: blocker to low |
| The repository's configured reviewer (`review.reviewer_app`, else `review.bots`) | its own | `bold-token`: `🟡 **medium** · 🏷️ category: correctness` | Jig's own words |

The `bold-token` row is **Jig's own finding format**. A reviewer a team builds
itself, an agent running in CI for example, gets severity and category
triage by opening each finding with it, once its login is the configured
reviewer or has an entry of its own below. The bullets of the reviewer's
summary comment are read in this format, after the formats of the login
that posted it.

Any other reviewer is added in `review.severity_formats`
([fields](CONFIGURATION.md#review)), one entry per login, without a change to
Jig:

```yaml
review:
  severity_formats:
    - login: example-reviewer[bot]
      shape: bold-token # 🔴 **Critical** · …
      severities: { Critical: blocker, Major: high, Minor: medium, Nit: low }
```

A repository's entries are tried before the built-in ones, and add to them
rather than replace them: a comment an entry does not read is still tried
against the built-in formats for the same login. An entry picks
one of the supported shapes and supplies the reviewer's words; it cannot
describe a field built another way (a different decoration before the word,
a different layout). That is a new shape, a change to Jig with fixtures from
the reviewer's real comments, as is a reviewer many teams use contributed as
a built-in.

## Forge: GitHub

The skills that work on pull requests (`drive-pr`, `resolve-review-comments`,
`do-item` opening a pull request, `fix-ci`, the audit's configuration check,
`descar`'s open-pull-request check) call the GitHub command line (`gh`)
directly. There is no forge interface: GitHub is the one platform Jig
supports. What they rely on:

- pull requests (state, base, draft and Ready) and their labels and comments;
- review threads, read, replied to and resolved through GitHub's GraphQL
  interface;
- check runs and commit statuses on a commit, and the required checks of
  branch protection and rulesets;
- GitHub Apps and `<app>[bot]` logins to recognise a reviewer;
- GitHub's stacks and the `gh-stack` extension, for
  `pull_requests.stacking: native`;
- `CODEOWNERS` and the "delete head branches on merge" setting, read and
  reported.

**Works without GitHub:** `adr`, `change-areas`, `code-stats`, `decide`, `explain`, `design-brief-builder`,
`programmatic-execution`, `promote-memory`, `resolve-conflicts`, `review` on a
local diff, `fix-ci` on a saved log (`--log <file>`), and the audit with
`--offline`. The modules' reference gates take their input as files or
arguments, and [M7's mappings](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/mappings.md)
state the review practice for GitLab and Gitea as well.

**The git remote** is `origin`: the drive pushes to it, fetches from it and
derives the integration branch from `origin/HEAD`. It refuses rather than
pushes when `origin` is not the pull request's repository. Roadmap item 10
makes the name configurable.

**What a second forge needs.** A forge interface on the model of the tracker
interface: the operations above, a GitHub implementation that the skills'
direct `gh` calls move into, then a second implementation (GitLab, through
its `glab` command, is the nearest). In `drive-pr`,
`resolve-review-comments` and `do-item` the `gh` calls already pass through
two helpers that add timeouts and caching, which is where the interface
starts; `fix-ci`, the audit and `descar` start `gh` through runners of their
own, and some skills tell the agent to run `gh` itself. The shared runtime
kernel gathers common timeout and cancellation behavior in `shared/`. A forge
interface is listed under the roadmap's later work, to be built when a team
on another forge needs it.

## CI system

Jig reads CI results from the forge, not from the CI system: the drive waits
for the check runs and commit statuses GitHub shows on a commit. Any CI that
reports to GitHub works (GitHub Actions, and GitLab CI, CircleCI, Buildkite
or Jenkins through their GitHub integrations). Where the required checks
cannot be read from branch protection, `ci.required_checks` names them.
`ci.hold_label` is a GitHub label the repository's own workflows must honour;
any CI that can read a pull request's labels can.

Bound to GitHub Actions today:

- **`fix-ci` downloading a failed run's log** (`gh run view --log-failed`).
  With another CI, save the log and run `parse-ci-log.ts --log <file>`; the
  sorting, fixing and local verification are the same.
- **The `github-actions` skill**, which reviews `.github/workflows` by
  definition. A review skill for another CI's files would be a sibling, not
  an option of this one.

The practice modules are written for any CI: their `mappings.md` give GitHub
Actions and GitLab CI side by side, and several name others. The audit
recognises the configuration files of GitHub Actions, GitLab CI, CircleCI,
Bitbucket Pipelines, Jenkins, Buildkite and others, and reads the jobs of the
first two. A CI provider interface for `fix-ci` (finding the failed run and
downloading its log) is listed under the roadmap's later work.

## Agent tools

The plugin installs into **Claude Code** and **Codex** from the same
`plugin/` directory, and every skill runs in both. The differences are in
the [Codex notes](README.md#codex-notes): Codex does not fill in the skill's
folder path, loads plugin agents only from its own folders, and the drive's
default pass starts Claude Code. Any other agent tool can use the skills by
copying or linking the whole `plugin/skills/` directory into its skill
folder, keeping every skill beside the others, and `plugin/shared/` into a
`shared/` folder beside that skill folder
([where it works](README.md#where-it-works)): skills' scripts import code
from `shared/` and from sibling skills (`fix-ci` from
`resolve-review-comments`, for one), so a single skill copied alone does not
run. The scripts need Bun, git
and the GitHub command line ([requirements](README.md#requirements)), and no
packages.
Supporting a third tool as a plugin means a manifest for it beside the existing ones in
`plugin/`, and a test in `tools/plugin/plugin.test.ts`.

## Workspace launcher

The [launcher](https://github.com/jig-harness/jig/blob/main/tools/launcher/README.md) connects an issue tracker's
"open in coding agent" button to a workspace on the machine. It has
interfaces of its own, each with one implementation chosen in
`~/.linear/launcher.yaml`:

- a **tracker** ([`tracker.ts`](https://github.com/jig-harness/jig/blob/main/tools/launcher/tracker.ts)): Linear;
- a **workspace provider** ([`provider.ts`](https://github.com/jig-harness/jig/blob/main/tools/launcher/provider.ts)):
  Conductor, which runs on macOS only.

A new provider is a module in `tools/launcher/providers/` that validates its
per-repository settings and opens the workspace, registered in `index.ts`
there; a tracker is added the same way under `trackers/`. A Herdr provider
is next: Herdr is the workspace runtime Jig's tooling targets first
([ADR-0005](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md),
[ROADMAP.md](https://github.com/jig-harness/jig/blob/main/ROADMAP.md) item 19).

## Operating systems

The skills are TypeScript run by Bun, which runs natively on macOS, Linux
and Windows ([ADR-0001](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0001-bun-typescript-toolchain.md)).
Every pull request to Jig is tested on Linux, and `main` on macOS and Windows
every night, where Windows leaves out only the suites listed in
`POSIX_ONLY_SUITES` in [scripts/gates.ts](https://github.com/jig-harness/jig/blob/main/scripts/gates.ts).

| Part | macOS | Linux | Windows | Why |
| --- | --- | --- | --- | --- |
| `drive-pr` | yes | yes | Git Bash; full smoke pending | Requires Git for Windows; native PowerShell support is planned |
| `do-item` | yes | yes | Git Bash; full smoke pending | Requires Git for Windows; native PowerShell support is planned |
| The launcher | yes | no | no | Its one provider, Conductor, is a macOS app |
| Every other skill | yes | yes | yes | — |
| Developing Jig (`bun run gates`) | yes | yes | yes, without the launcher's suite | — |

The supervision code finds and stops Windows processes from native snapshots
and a polled stop request. Batch command shims run through `cmd.exe`; skill
instructions and `fix-ci` setup commands use Git Bash's shell. The complete
Claude Code pickup, draft pull request, drive round and stop smoke test on
Windows remains pending. See the [requirements](README.md#requirements) for
the current platform boundary. On every system, Jig keeps its
state under `~/.local/state/jig` and `~/.cache/jig` in the home folder,
rather than in each system's own application-data folder. PowerShell support
remains on the roadmap.

## Practice mappings

The modules state each practice as an invariant that holds whatever the
tools, and each module's `mappings.md` names the tools that implement it in
each ecosystem: CI providers, hook managers, forges, trackers, agent tools,
package managers, telemetry backends. A team on a tool not listed there
adds a row or a section, with the tool's real configuration, in a pull
request to Jig ([modules/AGENTS.md](https://github.com/jig-harness/jig/blob/main/modules/AGENTS.md)). Each row is a
fact a reader can check, so it names what exists, not what is planned.

## Contributing an extension

An adapter, provider, command hook or new field arrives in Jig by pull
request, under [CONTRIBUTING.md](https://github.com/jig-harness/jig/blob/main/CONTRIBUTING.md) and
[plugin/AGENTS.md](https://github.com/jig-harness/jig/blob/main/plugin/AGENTS.md):

- **Values stay with the team.** The implementation holds the mechanism; a
  team's names, labels, hosts and credentials reach it through
  configuration or the environment, never as constants in the code.
- **Behind the interface, chosen by a field.** Callers use the interface,
  never the implementation; the field that chooses it goes into
  [CONFIGURATION.md](CONFIGURATION.md) and the audit's schema in the same
  pull request.
- **Tested without the service.** Tests run against a local fake of the
  service, so they run in CI without credentials.
- **Runs from the plugin cache.** No package dependencies at run time: Bun's
  built-ins, or a vendored single-file build with its licence
  ([adding a plugin skill](https://github.com/jig-harness/jig/blob/main/CONTRIBUTING.md#adding-or-changing-a-plugin-skill)).
- **Move, never copy.** An adapter a team already runs moves here with its
  tests, and the team deletes its own copy.
