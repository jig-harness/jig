# Groundwork's skills: the `groundwork` plugin

Agent procedures (*skills*) that many repositories use should have one
maintained source, so a fix reaches every repository at once and no copy drifts.
Without that, each repository carries its own copy of the same procedure, the
copies diverge, and every agent tool on every machine needs its own setup step
before a new working copy can use them.

Groundwork ships its skills as one **plugin**: an installable bundle that Claude
Code and Codex both understand. You install it **once per machine**. From then
on every repository, every [worktree](../GLOSSARY.md) and every session on that
machine has the skills; creating a new worktree, workspace or clone needs no
step at all. Each repository keeps only its own values (its gate command,
reviewer names, issue team) in one configuration file, which the skills read
when they run.

| Skill | What it does | Invoke as |
|-------|--------------|-----------|
| [drive-pr](skills/drive-pr/README.md) | Runs a pull request's review rounds unattended until it reaches one named end state (converged, waiting on a human, conflicting, …); each round is a fresh agent process, so a long drive never depends on one session surviving | `/groundwork:drive-pr` |
| [do-issue](skills/do-issue/SKILL.md) | Picks up one issue from the issue tracker, routes it to the right agent, implements it, opens a draft pull request and starts `drive-pr` on it | `/groundwork:do-issue` |
| [resolve-review-comments](skills/resolve-review-comments/README.md) | Walks every unresolved pull-request review thread to an explicit outcome, fixes, verifies, and resolves; repeats until reviewers settle | `/groundwork:resolve-review-comments` |

The plugin also ships agents (a [subagent](../GLOSSARY.md) is a separately prompted helper
that a skill hands a narrow job to):

| Agent | What it does | Available as |
|-------|--------------|--------------|
| [review-arbiter](agents/review-arbiter.md) | Rules on contested review findings the triage rubric cannot settle (fix now, reject, won't fix, defer or escalate to a human); reads code, never edits | `groundwork:review-arbiter` (Claude Code; see [Codex notes](#codex-notes)) |

Contents: [requirements](#requirements) ·
[install](#install-the-plugin) · [use](#use-a-skill) ·
[configure a repository](#configure-a-repository) ·
[drive loop and issue pickup](#the-drive-loop-and-issue-pickup) ·
[Codex notes](#codex-notes) ·
[update or remove](#update-pin-or-remove) ·
[where it works](#where-it-works) · [troubleshooting](#troubleshooting) ·
[how it works](#how-it-works) · [add a skill](#add-or-change-a-skill) ·
[release](#release-a-new-version) ·
[migrating from the per-worktree installer](#migrating-from-the-per-worktree-installer)

## Requirements

- **Claude Code** 2.1.292 or later and/or a **Codex CLI** with plugin support (tested with 0.159). Either
  one is enough; install for each one you use.
- **Bun** on `PATH`: the skills' scripts are TypeScript run by
  [Bun](https://bun.sh). Any recent Bun works; Groundwork tests with the
  version in [mise.toml](../mise.toml).
- **git** and the **GitHub CLI** (`gh`), signed in with access to the
  repositories you work on.
- **macOS or Linux for `drive-pr`.** Its driver supervises agent processes
  through POSIX process groups and signals, so it does not run on Windows.
  The other skills run on all three systems.
- **Issue-tracker access for `do-issue`** (and for `drive-pr`'s tracker
  reads): with the Linear adapter, `LINEAR_API_KEY` or `LINEAR_API_TOKEN` in
  the environment, or the Linear MCP server or `linear` command line tool
  signed in.
- **Read access to this repository.** It is private, so git must be able to
  fetch it without asking for a password. The simplest setup:
  `gh auth login`, then `gh auth setup-git`. The install commands below use the
  HTTPS address for that reason.

## Install the plugin

Run these once per machine, in a terminal (not inside an agent session).

**Claude Code** (one step: it registers the marketplace and installs; on
Claude Code older than 2.1.292, run `claude plugin marketplace add <address>`
and then `claude plugin install groundwork@groundwork` instead):

```sh
claude plugin install groundwork --marketplace https://github.com/docomply/jig.git
```

**Codex**:

```sh
codex plugin marketplace add https://github.com/docomply/jig.git
codex plugin add groundwork@groundwork
```

**Both at once**, from a checkout of this repository (it installs for each tool
it finds on `PATH`, and updates when already installed):

```sh
bun tools/plugin/setup.ts
```

**Check** what is installed (exit 1 when the plugin is missing for a tool that
is on `PATH`):

```sh
bun tools/plugin/setup.ts --check
claude plugin list        # shows groundwork@groundwork, enabled
codex plugin list         # same for Codex
```

Start a **new** session afterwards. Sessions that were already open load the
plugin after `/reload-plugins` (Claude Code) or a restart (Codex).

For an organization, an administrator can install it on every machine instead:
Claude Code reads `extraKnownMarketplaces` and `enabledPlugins` from
[managed settings](https://code.claude.com/docs/en/plugins/org), and a Codex
workspace administrator can sync a GitHub marketplace for the team.

## Use a skill

Plugin skills carry the plugin's name as a prefix.

- **Claude Code:** type `/groundwork:` and pick the skill, for example
  `/groundwork:resolve-review-comments 123`. Claude also uses a skill on its
  own when the request matches its description.
- **Codex:** ask for it by name ("use the groundwork:resolve-review-comments
  skill on PR 123"), or type `@` and choose it.

For example:

```text
/groundwork:do-issue ENG-123          # pick up an issue; opens a draft PR and starts a drive
/groundwork:drive-pr 456              # start an unattended drive of PR 456 in the background
/groundwork:drive-pr --interactive 456   # one round in this session, then stop
/groundwork:resolve-review-comments 456  # one review-resolution pass, no drive
```

Skills call the `review-arbiter` agent themselves when a finding is
contested; you do not invoke it by hand.

Run the agent from inside the repository you want it to work on. The skills
read that repository's configuration and refuse to run in a repository that has
none.

## Configure a repository

A repository adopts a skill by committing its values. Nothing else is
committed: no copy of the skill, no install script, no generated files.

1. **Create `.config/groundwork-overlay.yaml`** with the values the skill needs.
   This file is the *consumer overlay* (see the [glossary](../GLOSSARY.md)):
   the repository's own values, laid over the shared procedure. JSON is valid
   YAML, so a JSON-formatted file works too. The minimum for
   `resolve-review-comments`:

   ```yaml
   gates:
     command: bun run gates          # the full local checks before a push
   review:
     bots: ["coderabbitai[bot]"]     # reviewer identities to expect
     deferral_team: ENG              # issue-tracker team for follow-ups
   ```

   Every field, required or optional, is listed in the skill's
   [configuration table](skills/resolve-review-comments/README.md#consumer-configuration).
   Fields a skill does not read are ignored, so other tooling can share the
   file. Check it by running the skill's first step from the repository:
   `bun <plugin>/skills/resolve-review-comments/scripts/consumer-config.ts`
   prints the values or says what is missing.

2. **Tell agents and people where the skill comes from.** Add a short section
   to the repository's `AGENTS.md` (or equivalent), for example:

   ```markdown
   ## Shared skills (Groundwork)

   `/groundwork:resolve-review-comments` comes from the `groundwork` plugin,
   installed once per machine (see
   https://github.com/docomply/jig/blob/main/plugin/README.md#install-the-plugin).
   This repository's values are in `.config/groundwork-overlay.yaml`.
   If the skill is not listed, install the plugin and start a new session.
   ```

3. **Optional: let Claude Code offer the plugin to everyone who opens the
   repository.** Commit this in `.claude/settings.json` (merge it with any
   existing content):

   ```json
   {
     "extraKnownMarketplaces": {
       "groundwork": {
         "source": { "source": "git", "url": "https://github.com/docomply/jig.git" }
       }
     },
     "enabledPlugins": { "groundwork@groundwork": true }
   }
   ```

   Claude Code applies the marketplace entry only in a folder the person has
   trusted, so this is a convenience, not a replacement for the one-time
   install. It also names the plugin in the repository, which helps people
   discover it.

4. **Optional: pre-approve the gate command.** The skill pre-approves `git`,
   `gh` and `bun`. If the repository's gate command uses another tool (for
   example `pnpm`), add it to the repository's Claude Code permissions
   (`"permissions": { "allow": ["Bash(pnpm *)"] }` in `.claude/settings.json`)
   or approve it when asked.

The skills find each other beside themselves in the plugin: `drive-pr` runs
`resolve-review-comments` for each round, and `do-issue` starts `drive-pr`.
A repository that still keeps its own copy of one of these skills in
`.claude/skills/<name>` overrides the plugin's sibling, because the review
skill prefers the repository's copy; delete such leftovers when you adopt the
plugin's version.

## The drive loop and issue pickup

`drive-pr` and `do-issue` read the same configuration file as the review
skill. Every field below has a default except `issue_tracker.team`, which the
tracker scripts require. A drive also needs an AI reviewer that publishes the
check run, sticky comment and reviewed-commit marker described in the
[drive-pr README](skills/drive-pr/README.md#consumer-configuration); a
repository configured only for `resolve-review-comments` does not have that
yet. Add a field only when its default does not fit.

```yaml
repository:
  base_branch: develop        # default: the repository's default branch on GitHub
review:
  reviewer_app: example-review   # GitHub App whose check runs show the AI reviewer ran; default: none (any app's check run with a reviewer-shaped name)
drive:
  validation_plan_command: "bun tools/change-areas/resolve.ts --files - --format json"
                              # reads changed files on stdin, prints a JSON validation plan; default: run gates.command
  load_guard_command: "bun tools/dev/load-guard.ts --wait"   # waits while the machine is busy; default: none
  change_areas_catalog: tools/change-areas/catalog.yaml       # change-area catalog for area-aware reports; default: none
  reviews_drafts: true        # does the AI reviewer review draft pull requests
ci:
  required_checks: [build, test]   # check runs that must complete on the final head; default: what the base branch's protection requires
  hold_label: ci:hold         # label your workflows honour to skip heavy jobs between review rounds; default: none (every push runs full CI)
issue_tracker:
  team: ENG                   # issue-tracker team key; required by the tracker scripts
  adapter: linear             # which tracker adapter to use; Linear is the only one today
  file_command: "linear issue create"   # how an agent files an issue by hand
  states:                     # the tracker's own names for the workflow states
    backlog: Backlog
    todo: Todo
    in_progress: In Progress
    in_review: In Review
    done: Done
    canceled: Canceled
    triage: Triage
    ops_pending: Ops Pending
    duplicate: Duplicate
do_issue:
  agents:                     # which agent implements an issue
    default: general-purpose
    integrator: integrator
    labels: { frontend: frontend-dev }          # issue label → agent
    catalog: { api: backend-dev }               # catalog agent name → agent
    codearea_areas: { "area:billing": billing } # issue label → change-area key
  scouts:                     # agent → the scouts sent ahead of it (a list per agent)
    backend-dev: [schema-scout, api-scout]
  gates:                      # extra review skills a pickup must run first
    - { labels: [db-migration], paths: ["migrations/**"], skill: db-migration-review }
  execution_plan_block: execution-plan-v1   # fenced block name read from an epic's description
fleet_health:
  config: .config/fleet-health.yaml         # fleet-health settings file
  snapshot_dir: ~/.local/state/groundwork/dashboard   # where snapshots are written; `~` is expanded
```

The agent and scout names above are examples; use the agents your repository
defines. Note the direction of `do_issue.scouts`: it maps an **agent** to the
list of scouts that run before it, not a label to a scout.

**Add `.context/` to `.gitignore`.** A drive keeps working files there, at
the root of the working tree, and refuses to push or certify a tree with
untracked files.

**Continuous integration.** Without configuration a drive waits, on the final
head, for the checks the base branch's protection requires, and every push
runs the repository's normal CI. `ci.required_checks` names the checks instead;
`ci.hold_label` lets workflows written for it skip expensive jobs between
review rounds (see the [drive-pr README](skills/drive-pr/README.md#ci-hold)).

**Where a drive keeps its state.** A drive records its rounds, locks and
leases (a [lease](../GLOSSARY.md) is a short-lived claim that one session owns the pull
request's threads) outside the repository, in a per-clone folder:
`~/.local/state/groundwork/drive-pr/<clone>/` by default. Set
`DRIVE_PR_STATE_DIR` to move it. A machine that drove pull requests with an
earlier built-in copy of the skill moves its old state with
`bun <skill-dir>/scripts/migrate-state-dir.ts --from <old-dir>`. The
[verification-fit](../GLOSSARY.md) log (the agent's recorded verdicts on whether each round's
required validation was worth its cost) defaults to the Groundwork state
folder too; `GROUNDWORK_VERIFICATION_FIT_LOG` overrides it.

**How the skills reach the issue tracker.** `do-issue` and `drive-pr` talk to
the tracker only through a small [tracker interface](../GLOSSARY.md) (read an issue with its
comments, list its children, change its state, post a comment, run the
reports' queries). An *adapter* implements that interface for one tracker;
`issue_tracker.adapter` chooses it, and Linear is the only adapter today.
`issue_tracker.states` translates the skills' state names (`in_progress`,
`done`, …) into the tracker's own. Supporting another tracker means adding an
adapter, not changing the skills.

The remaining knobs are environment variables named `DRIVE_PR_*` (round
limits, timeouts, repair budgets); the [drive-pr README](skills/drive-pr/README.md)
lists them.

## Codex notes

- **Skills** work in Codex as in Claude Code. Codex does not fill in
  `${CLAUDE_SKILL_DIR}`; each `SKILL.md` tells the agent to substitute the
  skill's own directory.
- **The `review-arbiter` agent is Claude Code only.** Codex plugins carry
  skills, MCP servers, apps and hooks, but not agents; Codex reads custom
  agents only from its own agent folders (`~/.codex/agents/` or a
  repository's `.codex/agents/`). In a Codex session, hand a contested
  finding to a subagent that is given
  [`agents/review-arbiter.md`](agents/review-arbiter.md) as its
  instructions, or define the arbiter once as a Codex custom agent from that
  file.
- **The drive's default pass command** starts Claude Code
  (`claude -p "/groundwork:drive-pr <PR>"`). To drive with Codex, put a Codex
  command after the `--` in the
  [start command](skills/drive-pr/README.md#how-to-start-it).

## Call a skill's scripts from repository code

Normally only the agent runs a skill's scripts. When a repository's own code
also needs them (for example a sibling skill that imports a shared module, or
a status board that runs `await-round.ts`), it must find the installed copy;
there is no copy inside the repository any more. Look in this order and fail
with a clear message when none is found:

1. `GROUNDWORK_SKILLS_DIR`, set by the caller (CI jobs and tests point it at
   a checkout of this repository's `plugin/skills`).
2. Claude Code: the entry with `"id": "groundwork@groundwork"` and
   `"scope": "user"` in `claude plugin list --json`: its `readFromFolder` when
   present (a plugin loaded in place from a local marketplace), otherwise its
   `installPath`; append `/skills` and check that the directory exists.
3. Codex: the `version` of `groundwork@groundwork` in `codex plugin list --json`,
   then `${CODEX_HOME:-~/.codex}/plugins/cache/groundwork/groundwork/<version>/skills`.

Paths inside the cache change with each release, so never store them.

## Update, pin or remove

- **Update** to the latest release: `bun tools/plugin/setup.ts`, or by hand
  `claude plugin marketplace update groundwork && claude plugin update groundwork@groundwork --scope user`
  and `codex plugin marketplace upgrade groundwork && codex plugin add groundwork@groundwork`.
  A tool picks up a new release only when the plugin's `version` changes (see
  [release](#release-a-new-version)). Claude Code can also update in the
  background: `/plugin` → **Marketplaces** → `groundwork` →
  **Enable auto-update**.
- **Pin** a machine to a release tag: add the marketplace at that tag,
  `claude plugin install groundwork --marketplace https://github.com/docomply/jig.git#v0.3.0`,
  or `codex plugin marketplace add https://github.com/docomply/jig.git --ref v0.3.0`.
  Versions are chosen per machine, not per repository: every repository on a
  machine uses the same release, so releases keep reading older configuration
  files unless their notes say otherwise.
- **What `main` means:** both tools install from the default branch, but a
  machine only receives a change when `version` changes. Every pull request
  that changes `plugin/` therefore bumps the version (see
  [release](#release-a-new-version)); otherwise two machines showing the same
  version can run different code.
- **Remove**: `claude plugin uninstall groundwork@groundwork` and
  `codex plugin remove groundwork@groundwork` (add
  `claude plugin marketplace remove groundwork` /
  `codex plugin marketplace remove groundwork` to forget the source too).

## Where it works

The plugin lives in each tool's user-level plugin directory
(`~/.claude/plugins/`, `~/.codex/plugins/`), so it applies wherever that tool
runs as you:

| Where | What to do |
|-------|------------|
| A terminal session in any clone or worktree | Nothing beyond the one-time install |
| Conductor, herdr, or any tool that creates worktrees and starts sessions | Nothing: new workspaces are ordinary directories on a machine that has the plugin |
| `claude -p`, `codex exec`, scripts and loops | Nothing; plugins load in headless runs too |
| A container image or CI runner that runs an agent | Install at image build: run the install commands with git credentials available. For Claude Code, build a read-only *seed* with `CLAUDE_CODE_PLUGIN_CACHE_DIR=/opt/claude-seed claude plugin install groundwork --marketplace …`, set `CLAUDE_CODE_PLUGIN_SEED_DIR=/opt/claude-seed` at run time, and enable it with `enabledPlugins` ([details](https://code.claude.com/docs/en/plugins/org#seed-containers-and-ci)). For Codex, run the two install commands in the image, or copy `plugin/skills/*` to `/etc/codex/skills/` |
| CI jobs that only run tests and gates | Nothing: they do not need the skills |
| A runner that gives each session its own Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) | A user-level install lives in the default directory and is not seen there. Build a seed once (as for containers) and set `CLAUDE_CODE_PLUGIN_SEED_DIR` in the runner's environment; repositories enable the plugin through `enabledPlugins` in `.claude/settings.json` |
| A tool without plugin support | Copy or link `plugin/skills/<name>` into that tool's user skill directory (for example `~/.claude/skills/` or `~/.agents/skills/`); the command name is then the bare skill name |

## Troubleshooting

- **The skill is not in the `/` menu.** Run `bun tools/plugin/setup.ts --check`
  (or `claude plugin list` / `codex plugin list`). If it is installed, the
  session started before the install: run `/reload-plugins` (Claude Code) or
  start a new session.
- **Install fails with an authentication or "repository not found" error.**
  git could not read the private repository without a prompt. Run
  `gh auth login` and `gh auth setup-git`, then retry with the HTTPS address
  above. Check with `git ls-remote https://github.com/docomply/jig.git`.
- **"Groundwork configuration not found"** — the agent is working in a
  repository that has not [configured](#configure-a-repository) the skill, or
  outside any repository. Start the agent in the repository, or add the
  configuration file.
- **"lacks required values"** — the configuration file exists but misses a
  required field; the message names it.
- **`bun: command not found`** inside a session — the tool's shell does not
  see Bun. Install Bun globally or make sure the version manager that provides
  it (for example mise) is active in non-interactive shells.
- **A script path starts with `/scripts/`** — the command was run with an
  unexpanded `${CLAUDE_SKILL_DIR}`. In Codex the agent must substitute the
  skill's directory itself; [SKILL.md](skills/resolve-review-comments/SKILL.md) tells
  it to. Re-run with the skill's absolute directory.
- **Old behaviour after an update** — the tool still has the previous version
  cached; a release reaches a machine only when `version` changes. Run the
  update commands above and start a new session.

## How it works

This repository is a marketplace (a catalog a tool installs plugins from) for
each tool, listing one plugin, the `plugin/` directory:

```text
.claude-plugin/marketplace.json          Claude Code marketplace: one plugin, source "./plugin"
.agents/plugins/marketplace.json         Codex marketplace: one plugin, source "./plugin"
plugin/.claude-plugin/plugin.json        Claude Code plugin manifest
plugin/.codex-plugin/plugin.json         Codex plugin manifest
plugin/skills/<name>/SKILL.md            the skills both tools load
plugin/skills/<name>/scripts/            the scripts the skills run
plugin/agents/<name>.md                  agents Claude Code loads (Codex: see Codex notes)
```

The plugin is a directory of its own rather than the repository root for two
reasons: Claude Code installs a plugin's package dependencies when its root has
a `package.json` (this repository's development dependencies would then be
downloaded onto every machine), and Codex finds skills only in a subdirectory of the plugin.
Both tools copy `plugin/` into their plugin cache at install time and load
every `skills/<name>/SKILL.md`. One `SKILL.md` serves both: Claude Code fills
in `${CLAUDE_SKILL_DIR}` with the skill's directory, and the procedure tells
any other tool to do the same. Each script finds its repository by walking up
from the directory the agent runs it in, then reads that repository's
`.config/groundwork-overlay.yaml`.

Why per machine rather than per repository: an agent tool lists the skills it
can see when a session starts. A skill installed into each worktree therefore
needs something to run in every new directory before the session starts, and
every tool creates directories differently; a skill installed once per machine
is already visible everywhere. The trade-off is that versions are chosen per
machine, so skills stay compatible with older configuration files wherever
they can; a change that needs a configuration edit is a major release, and the
skill's first step names the edit.

[tools/plugin/plugin.test.ts](../tools/plugin/plugin.test.ts) checks both
manifests and marketplaces and runs the scripts from a copy outside this repository against a
scratch consumer repository, the way a plugin cache holds them.

## Add or change a skill

A skill moves here under the rules in [AGENTS.md](../AGENTS.md) (move, never
copy; the consumer's own values stay in the consumer). For it to work as part
of the plugin:

- **Location:** `plugin/skills/<name>/SKILL.md`, with `name: <name>` in its
  frontmatter. Supporting files sit beside it (`scripts/`, `references/`).
- **Paths:** reach your own files as `${CLAUDE_SKILL_DIR}/…` in `SKILL.md`, and
  explain the placeholder once for other tools, as
  [resolve-review-comments](skills/resolve-review-comments/SKILL.md#paths-and-working-directory)
  does. Reference files are not substituted; write `<skill-dir>/…` there.
  Never write a path into the consumer repository such as
  `.claude/skills/<name>/…` for your own files.
- **Working directory:** scripts run with the consumer repository as the
  working directory and must not depend on being run from the skill directory.
- **Consumer values:** read them at run time from
  `.config/groundwork-overlay.yaml` (see
  `resolve-review-comments/scripts/lib/consumer.ts`), fail with a clear message
  when a required value is missing, and accept older files. Never bake a
  repository's values into `SKILL.md`.
- **Dependencies:** the plugin cache has no `node_modules`. Use Bun and Node
  built-ins, or vendor a dependency's own single-file build beside the script
  with its licence and a test that keeps it identical to the pinned package
  (as `resolve-review-comments/scripts/lib/vendor/js-yaml.mjs` is).
- **Harness frontmatter:** fields only one tool reads (Claude Code's
  `allowed-tools`, `argument-hint`) are ignored by the other.
- **Tests:** keep the skill's tests in `plugin/skills/<name>/__tests__/`; extend
  `tools/plugin/plugin.test.ts` when the skill reads consumer files. A suite
  that needs a POSIX system is listed in `POSIX_ONLY_SUITES` in
  [scripts/gates.ts](../scripts/gates.ts), with the reason, so Windows CI
  leaves it out; a suite too long for the gate job goes in `SEPARATE_SUITES`
  and gets its own sharded job in
  [the gates workflow](../.github/workflows/gates.yml).
- **Agents:** put them in `plugin/agents/<name>.md` with `name: <name>` in
  the frontmatter. Claude Code loads that folder without a manifest entry;
  do not add an `agents` key to the manifest, which would replace the
  folder scan. Leave the model unpinned so the agent runs on the session's
  model.

## Release a new version

1. In the pull request that changes `plugin/`, bump `version` in **both** `plugin/.claude-plugin/plugin.json` and
   `plugin/.codex-plugin/plugin.json` (the plugin test fails when they differ). Use
   [semantic versioning](https://semver.org): a change that needs consumers to
   edit their configuration is a major version, and its release notes say what
   to change.
2. Merge it with green gates.
3. Tag the merge commit `v<version>` and push the tag.

Machines receive the release on their next update. Repositories need no change
unless the release notes say so.

## Migrating from the per-worktree installer

Releases up to `v0.1.1-review-pilot` were installed into each worktree by a
pinned installer (`.groundwork/`, links under `.claude/skills` and
`.agents/skills`, a bootstrap script run from `postinstall`, a git hook and a CI
step). Those tags stay available, so a repository still pinned to one keeps
working until it migrates. To migrate a repository:

1. Keep `.config/groundwork-overlay.yaml`; fields the plugin does not read are
   ignored. One value needs attention: since `v0.1.1-review-pilot`, a
   `review.job_pattern` requires `review.required_checks` (the exact check
   names that must complete). Older files often carry a pattern such as
   `"AI review|CodeRabbit"` only because that release could not render `null`;
   set it to `null` (reviewer checks are then recognised by name) or add
   `required_checks`. The skill's first step refuses the file until then.
   `harness.claude_frontmatter` and `harness.codex_frontmatter` are no longer
   applied: the skill runs on the session's model, and tools it needs beyond
   `git`, `gh` and `bun` (such as an issue-tracker tool or the gate command's
   package manager) go into the repository's permissions, for example
   `permissions.allow` in `.claude/settings.json`.
2. Remove the per-worktree machinery: the Groundwork pin and assets in the
   standards manifest, the projected bootstrap script and CI action, its
   `postinstall` line, git hook and setup-script calls, CI steps that installed
   the skill, and the installer's block in `.gitignore`.
3. If repository code imported the installer's shared helpers from
   `.groundwork/lib/` (guarded git spawning, test helpers, the temp-directory
   preload), replace those imports first: the plugin does not ship them. Copy
   the helpers into the repository from Groundwork's `lib/` at the tag you
   used, or drop the imports. None of the repositories migrated so far
   imported them.
4. Delete the leftovers in each existing checkout: `.groundwork/`,
   `.claude/skills/resolve-review-comments` and
   `.agents/skills/resolve-review-comments` (all were ignored by git). In the
   base clone, remove a `.git/hooks/post-checkout` that existed only for the
   install: one whose second line reads `# groundwork:managed post-checkout`,
   or a lefthook-generated one when the repository no longer declares a
   `post-checkout` job (lefthook keeps the file after the job is deleted;
   reinstall lefthook's hooks afterwards, for example with
   `npx lefthook install`).
5. Repository code that ran the skill's scripts by their old path
   (`.claude/skills/resolve-review-comments/scripts/…`) must
   [find the installed copy](#call-a-skills-scripts-from-repository-code)
   instead.
6. Update instructions that name `/resolve-review-comments` to
   `/groundwork:resolve-review-comments`, and add the `AGENTS.md` section from
   [Configure a repository](#configure-a-repository).
7. Install the plugin on each machine.
