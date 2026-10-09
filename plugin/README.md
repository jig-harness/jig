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
| [resolve-review-comments](skills/resolve-review-comments/README.md) | Walks every unresolved pull-request review thread to an explicit outcome, fixes, verifies, and resolves; repeats until reviewers settle | `/groundwork:resolve-review-comments` |

Contents: [requirements](#requirements) ·
[install](#install-the-plugin) · [use](#use-a-skill) ·
[configure a repository](#configure-a-repository) ·
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

Some skills integrate with a repository's own skills. For example
`resolve-review-comments` uses a `drive-pr` skill when the repository has one
in `.claude/skills/drive-pr`; the skill's README says what each integration
adds and what happens without it.

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
  `claude plugin install groundwork --marketplace https://github.com/docomply/jig.git#v0.2.0`,
  or `codex plugin marketplace add https://github.com/docomply/jig.git --ref v0.2.0`.
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
  `tools/plugin/plugin.test.ts` when the skill reads consumer files.

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
