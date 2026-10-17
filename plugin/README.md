# Jig's skills: the `jig` plugin

Agent procedures (*skills*) that many repositories use should have one
maintained source, so a fix reaches every repository at once and no copy drifts.
Without that, each repository carries its own copy of the same procedure, the
copies diverge, and every agent tool on every machine needs its own setup step
before a new working copy can use them.

Jig ships its skills as one **plugin**: an installable bundle that Claude
Code and Codex both understand. You install it **once per machine**. From then
on every repository, every [worktree](../GLOSSARY.md) and every session on that
machine has the skills; creating a new worktree, workspace or clone needs no
step at all. Each repository keeps only its own values (its gate command,
reviewer names, issue team) in one configuration file, which the skills read
when they run.

The skills come in groups, each in the order its skills are used. The
last column says how a skill connects to the others: what starts it, what it
runs, what it hands over to.

**Deliver a change.** One item of work, from the tracker to a merged pull request. `do-item` opens the pull request and arms `drive-pr`; `drive-pr` runs one `resolve-review-comments` pass per review round, works a conflict through `resolve-conflicts`, and repairs red CI in its own repair round; `fix-ci` is the repair by hand when no drive runs or its budget is spent. Each also works by hand.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [do-item](skills/do-item/SKILL.md) | Picks up one work item from whatever the tracker adapter reads (an issue tracker today, a plan file in future), routes it to the right agent, implements it, opens a pull request as the repository's pull-request policy says and starts `drive-pr` on it | `/jig:do-item` | Starts [drive-pr](skills/drive-pr/README.md) on the pull request it opens; runs its own pre-pull-request review in the same tiers as [review](skills/review/SKILL.md), plus each review skill its declared gates name; escalates a dilemma to [decide](skills/decide/SKILL.md) |
| [drive-pr](skills/drive-pr/README.md) | Runs a pull request's review rounds unattended until it reaches one named end state (converged, waiting on a human, conflicting, …); each round is a fresh agent process, so a long drive never depends on one session surviving | `/jig:drive-pr` | Started by [do-item](skills/do-item/SKILL.md); runs [resolve-review-comments](skills/resolve-review-comments/README.md) every review round; calls [resolve-conflicts](skills/resolve-conflicts/SKILL.md) when the branch conflicts; repairs red CI in its own repair round, with the repository's CI-repair skill if it has one |
| [resolve-review-comments](skills/resolve-review-comments/README.md) | Walks every unresolved pull-request review thread to an explicit outcome, fixes, verifies, and resolves; repeats until reviewers settle | `/jig:resolve-review-comments` | One review round of [drive-pr](skills/drive-pr/README.md); hands contested findings to the `review-arbiter` agent and design questions to [decide](skills/decide/SKILL.md) |
| [resolve-conflicts](skills/resolve-conflicts/SKILL.md) | Resolves a stopped merge, rebase or cherry-pick: names each side by role, traces why each side changed, regenerates lockfiles and generated files, records every decision in the commit message and checks that no change was silently dropped | `/jig:resolve-conflicts` | Runs in [drive-pr](skills/drive-pr/README.md)'s conflict round; [fix-ci](skills/fix-ci/SKILL.md) takes over for checks that fail after the merge |
| [fix-ci](skills/fix-ci/SKILL.md) | Fetches a failed CI run's log, sorts the errors, fixes them and verifies locally before pushing | `/jig:fix-ci` | The repair by hand when no [drive-pr](skills/drive-pr/README.md) drive is running or its CI-repair budget is spent; [github-actions](skills/github-actions/SKILL.md) reviews the fix when it changes a workflow |

**Review a change.** Check work against the repository's own standards before and during review.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [review](skills/review/SKILL.md) | Reviews a diff, plan or pull request in tiers (pattern checks, contract checks, semantic review) against the repository's decision rules and change-area catalog | `/jig:review` | Its tiers are the ones [do-item](skills/do-item/SKILL.md)'s pre-pull-request gate runs; reads the rules [adr](skills/adr/SKILL.md) derives; posts none of its findings to the pull-request threads [resolve-review-comments](skills/resolve-review-comments/README.md) settles, which come from the pull request's own reviewers |
| [github-actions](skills/github-actions/SKILL.md) | Reviews GitHub Actions workflow changes for security, pinning, concurrency keys, caching and the repository's own workflow conventions | `/jig:github-actions` | The workflow-specific form of [review](skills/review/SKILL.md); sends a red CI run to [fix-ci](skills/fix-ci/SKILL.md) |

**Understand, decide and record.** Design-level work: learn how it works today, settle the question, write the answer where the next session finds it.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [explain](skills/explain/SKILL.md) | Writes a cited, commit-dated explainer sheet (HTML and Markdown) of how part of the system works today | `/jig:explain` | Comes before [decide](skills/decide/SKILL.md) and shares its sheet kit; cites the records [adr](skills/adr/SKILL.md) keeps |
| [decide](skills/decide/SKILL.md) | Settles a technical dilemma: searches the repository's precedent first, then rules or escalates to a human with a cited decision sheet | `/jig:decide` | Called by [do-item](skills/do-item/SKILL.md) and [resolve-review-comments](skills/resolve-review-comments/README.md) when a call is architectural; routes an outcome that clears the bar to [adr](skills/adr/SKILL.md) |
| [adr](skills/adr/SKILL.md) | Creates, updates and checks architecture decision records and the machine-readable rules derived from them | `/jig:adr` | Records what [decide](skills/decide/SKILL.md) rules; its rules are what [review](skills/review/SKILL.md) checks against |
| [design-brief-builder](skills/design-brief-builder/SKILL.md) | Assembles the numbered brief bundle for a session with an external design tool (Claude Design, so far), grounded in the repository's real schema and code | `/jig:design-brief-builder` | Stands alone: the design-prototype station, ahead of the delivery skills |

**Learn from the work.** What a session learned about the scaffolding goes into a shared store; a person approves what changes; lasting lessons end up in the repository's own documents.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [reflect](skills/reflect/README.md) | Records what a session learned about the repository's scaffolding (instructions, skills, gates) in a store every repository shares: merges duplicates, names each finding's class, escalates a class that keeps recurring to one tracker issue. On only when the configuration has a `reflection` section | `/jig:reflect` | Offered at the end of a [drive-pr](skills/drive-pr/README.md) and by [do-item](skills/do-item/SKILL.md); its findings are what [review-reflections](skills/review-reflections/README.md) reads |
| [review-reflections](skills/review-reflections/README.md) | Turns the stored findings into changes a person approves: reconciles approved fixes with what merged, groups what recurred, proposes a change, deferral, dismissal or escalation per group, and records each decision | `/jig:review-reflections` | The second half of [reflect](skills/reflect/README.md): run it periodically, or when a class of finding keeps recurring |
| [promote-memory](skills/promote-memory/SKILL.md) | Turns an agent's private memory into a reviewed, shared document in the repository | `/jig:promote-memory` | Sends an architectural lesson to [adr](skills/adr/SKILL.md); a page it promotes gets a [descar](skills/descar/SKILL.md) pass before it becomes a permanent, approved document |
| [descar](skills/descar/SKILL.md) | Removes review history, correction ledgers and finished-work rows from a promoted document, keeping what a reader needs now | `/jig:descar` | The pass a page [promote-memory](skills/promote-memory/SKILL.md) promoted gets before it becomes a permanent, approved document; runs on any docs page before it is promoted |

**Inspect and analyse.** Tools that inspect the repository: `audit` records its findings; `changelog` keeps its changelog and version; `programmatic-execution` runs read-only analysis.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [audit](skills/audit/README.md) | Audits the repository against Jig's practice modules: checks its `.config/jig.yaml` against the repository, scores every module's maturity criteria with evidence, and records the result in the repository so the next audit reports what changed | `/jig:audit` | Opens the pull request for an applied recommendation under [do-item](skills/do-item/SKILL.md)'s pull-request policy and offers [drive-pr](skills/drive-pr/README.md) on it |
| [changelog](skills/changelog/README.md) | Keeps a repository's changelog and version from change notes: each pull request adds a small note instead of editing the changelog, a release step writes the notes in after the merge, and the skill's commands check a branch and show the next release. On only where the repository's `.config/jig.yaml` sets `changelog.file` | `/jig:changelog` | Stands alone for now; its release step is what a merged [do-item](skills/do-item/SKILL.md) pull request waits on for its version |
| [programmatic-execution](skills/programmatic-execution/SKILL.md) | Runs bulk read-only analysis as one script instead of many tool calls, so large outputs stay out of the conversation | `/jig:programmatic-execution` | Supports every other skill; none depends on it |

The plugin also ships agents (a [subagent](../GLOSSARY.md) is a separately prompted helper
that a skill hands a narrow job to):

| Agent | What it does | Available as |
|-------|--------------|--------------|
| [review-arbiter](agents/review-arbiter.md) | Rules on contested review findings the triage rubric cannot settle (fix now, reject, won't fix, defer or escalate to a human); reads code, never edits | `jig:review-arbiter` (Claude Code; see [Codex notes](#codex-notes)) |

Contents: [requirements](#requirements) ·
[install](#install-the-plugin) · [use](#use-a-skill) ·
[configure a repository](#configure-a-repository) ·
[drive loop and issue pickup](#the-drive-loop-and-issue-pickup) ·
[procedure skills](#the-procedure-skills) ·
[Codex notes](#codex-notes) ·
[update or remove](#update-pin-or-remove) ·
[where it works](#where-it-works) · [troubleshooting](#troubleshooting) ·
[how it works](#how-it-works) ·
[release](#releases) ·
[moving from the `groundwork` plugin](#moving-from-the-groundwork-plugin) ·
[moving off the per-worktree installer](#moving-off-the-per-worktree-installer)

## Requirements

| Tool | Version | Needed for |
|------|---------|------------|
| **Claude Code** and/or a **Codex CLI** with plugin support | Claude Code 2.1.292 or later for the one-step install below (older: the two-step install), and 2.1.285 or later for a drive's [long background commands](skills/drive-pr/README.md#the-background-time-limit). Codex: tested with 0.159 | Every skill. Either tool is enough; install for each one you use |
| **[Bun](https://bun.sh)** on `PATH` | The version in [mise.toml](../mise.toml), which Jig tests; an older Bun may lack an API a script uses | Every skill's scripts, which are TypeScript run by Bun. The repository being worked on needs no Bun of its own |
| **git** | 2.36 or later (`--path-format` for absolute paths and `git worktree list -z`; `resolve-conflicts` needs 2.31) | Every skill that reads the repository |
| **GitHub CLI** (`gh`), signed in with access to the repositories you work on | 2.48 or later (`gh api --slurp`) | Every skill that works on pull requests. Jig supports GitHub as its only forge ([extending](EXTENDING.md#forge-github)) |
| **The `gh-stack` extension** | Any | Only `pull_requests.stacking: native` |
| **Issue-tracker access** | — | `do-item`, and `drive-pr`'s tracker reads. With the Linear adapter: `LINEAR_API_KEY` or `LINEAR_API_TOKEN` in the environment, or the Linear MCP server or `linear` command line tool signed in |

Nothing checks these versions when a skill runs: an older tool fails on the
command it lacks.

- **macOS or Linux for `drive-pr` and `do-item`.** The driver supervises
  agent processes through [POSIX](../GLOSSARY.md) process groups and
  signals, so it does not run on Windows, and `do-item` is not tested there.
  The other skills run on all three systems
  ([operating systems](EXTENDING.md#operating-systems)).
- **Read access to this repository.** It is private, so git must be able to
  fetch it without asking for a password. The simplest setup:
  `gh auth login`, then `gh auth setup-git`. The install commands below use the
  HTTPS address for that reason.

## Install the plugin

Run these once per machine, in a terminal (not inside an agent session).

**Claude Code** (one step: it registers the marketplace and installs; on
Claude Code older than 2.1.292, run `claude plugin marketplace add <address>`
and then `claude plugin install jig@jig` instead):

```sh
claude plugin install jig --marketplace https://github.com/docomply/jig.git
```

**Codex**:

```sh
codex plugin marketplace add https://github.com/docomply/jig.git
codex plugin add jig@jig
```

**Both at once**, from a checkout of this repository (it installs for each tool
it finds on `PATH`, and updates when already installed):

```sh
bun tools/plugin/setup.ts
```

**Check** what is installed (exit 1 when the plugin is missing or disabled
for a tool that is on `PATH`):

```sh
bun tools/plugin/setup.ts --check
claude plugin list        # shows jig@jig, enabled
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

- **Claude Code:** type `/jig:` and pick the skill, for example
  `/jig:resolve-review-comments 123`. Claude also uses a skill on its
  own when the request matches its description.
- **Codex:** ask for it by name ("use the jig:resolve-review-comments
  skill on PR 123"), or type `@` and choose it.

For example:

```text
/jig:do-item ENG-123           # pick up an issue; opens a PR and starts a drive
/jig:drive-pr 456              # start an unattended drive of PR 456 in the background
/jig:drive-pr --interactive 456   # one round in this session, then stop
/jig:resolve-review-comments 456  # one review-resolution pass, no drive
```

Skills call the `review-arbiter` agent themselves when a finding is
contested; you do not invoke it by hand.

Run the agent from inside the repository you want it to work on. The skills
read that repository's configuration. `resolve-review-comments` (and with it
every `drive-pr` round) and `do-item`'s tracker scripts refuse to run in a
repository that has none; the other skills fall back to their defaults.

## Configure a repository

A repository adopts a skill by committing its values. Nothing else is
committed: no copy of the skill, no install script, no generated files.

1. **Create `.config/jig.yaml`** with the values the skill needs.
   This file is the *consumer overlay* (see the [glossary](../GLOSSARY.md)):
   the repository's own values, laid over the shared procedure. JSON is valid
   YAML, so a JSON-formatted file works too. The minimum for
   `resolve-review-comments`:

   ```yaml
   gates:
     command: make check             # the full local checks before a push
   review:
     bots: ["example-review[bot]"]   # your AI reviewer's login
     deferral_team: ENG              # issue-tracker team for follow-ups
   ```

   Every field of every skill, its type, its default and what the skills
   derive instead of asking for, is in the
   [configuration reference](CONFIGURATION.md); the skill's own
   [configuration table](skills/resolve-review-comments/README.md#consumer-configuration)
   explains its fields. What a repository can adapt beyond values (its own
   commands, other trackers and stores, other platforms) is in
   [EXTENDING.md](EXTENDING.md).
   Fields a skill does not read are ignored, so other tooling can share the
   file. Check it by running the skill's first step from the repository:
   `bun <plugin>/skills/resolve-review-comments/scripts/consumer-config.ts`
   prints the values or says what is missing, and
   `bun <plugin>/skills/audit/scripts/config-fit.ts` checks every field
   against the plugin's schema and the repository (misspelt or deprecated
   fields, commands and paths that do not exist, required checks that never
   run).

   Values that are yours rather than the repository's go in `~/.jig/jig.yaml`,
   which every repository on the machine reads below its own file; an
   environment variable overrides both for one run. The
   [configuration layers](CONFIGURATION.md#configuration-layers) section
   explains the order, and
   `bun <plugin>/skills/resolve-review-comments/scripts/jig-config.ts` shows
   which layer set each value.

2. **Tell agents and people where the skill comes from.** Add a short section
   to the repository's `AGENTS.md` (or equivalent), for example:

   ```markdown
   ## Shared skills (Jig)

   `/jig:resolve-review-comments` comes from the `jig` plugin,
   installed once per machine (see
   https://github.com/docomply/jig/blob/main/plugin/README.md#install-the-plugin).
   This repository's values are in `.config/jig.yaml`.
   If the skill is not listed, install the plugin and start a new session.
   ```

3. **Optional: let Claude Code offer the plugin to everyone who opens the
   repository.** Commit this in `.claude/settings.json` (merge it with any
   existing content):

   ```json
   {
     "extraKnownMarketplaces": {
       "jig": {
         "source": { "source": "git", "url": "https://github.com/docomply/jig.git" }
       }
     },
     "enabledPlugins": { "jig@jig": true }
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
`resolve-review-comments` for each round, and `do-item` starts `drive-pr`.
One exception: when the repository keeps its own copy of `drive-pr` in
`.claude/skills/drive-pr`, the review skill uses that copy instead of the
plugin's. Delete such a copy when you adopt the plugin's version.

## The drive loop and issue pickup

`drive-pr` and `do-item` read the same configuration file as the review
skill. Every field below has a default except `issue_tracker.team`, which the
tracker scripts require. A drive does not need an AI reviewer: without one it
converges on review threads and CI alone. A repository that has one names it
with `review.reviewer_app` (or `review.reviewer_check_pattern`), and the drive
then also waits for the check run, sticky comment and reviewed-commit marker
described in the
[drive-pr README](skills/drive-pr/README.md#consumer-configuration). Add a
field only when its default does not fit. The
[configuration reference](CONFIGURATION.md) lists every field, including the
`pull_requests` policy below.

```yaml
repository:
  base_branch: develop        # default: the repository's default branch on GitHub
pull_requests:                # how agents open and stack pull requests
  stacking: none              # none | native (GitHub stacks) | branch (plain chains); default none
  open_as: draft              # draft | ready; default draft
  mark_ready: 1               # drive marks a draft Ready after round N | converged | never; default 1
  branch_name: "{key_lower}-{slug}"   # must contain {key} or {key_lower}
  issue_link: closes          # closes | refs | none
  size_budget: 600            # changed lines per pull request; default: no budget
review:
  reviewer_app: example-review   # GitHub App whose check runs show the AI reviewer ran; naming it (or reviewer_check_pattern) is what makes drive-pr wait for a reviewer; default: none, no reviewer expected
drive:
  validation_plan_command: "<your plan command>"
                              # reads changed files on stdin, prints a JSON validation plan; default: run gates.command
  load_guard_command: "<your load-guard command>"   # returns once the machine can take heavy checks; default: none
  change_areas_catalog: docs/change-areas.yaml      # change-area catalog for area-aware reports; default: none
  reviews_drafts: true        # does the AI reviewer review draft pull requests
  max_rounds: 10              # default round budget of a drive-pr run; --max-rounds overrides; default 10
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
do_item:
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
  snapshot_dir: ~/.local/state/jig/dashboard   # where snapshots are written; `~` is expanded
```

The agent and scout names above are examples; use the agents your repository
defines. Note the direction of `do_item.scouts`: it maps an **agent** to the
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
`~/.local/state/jig/drive-pr/<clone>/` by default. Set
`DRIVE_PR_STATE_DIR` to move it; to move existing state into another folder,
run `bun <skill-dir>/scripts/migrate-state-dir.ts --from <old-dir>` (see the
[drive-pr README](skills/drive-pr/README.md#relocating-the-state-dir)). The
[verification-fit](../GLOSSARY.md) log (the agent's recorded verdicts on whether each round's
required validation was worth its cost) defaults to the Jig state
folder too; `JIG_VERIFICATION_FIT_LOG` overrides it.

**How the skills reach the issue tracker.** `do-item` and `drive-pr` talk to
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

## The procedure skills

Every skill except `do-item`, `drive-pr` and `resolve-review-comments`
(the drive loop, above), `reflect` and `review-reflections` (on only
with a `reflection` section) and `changelog` (on only where
`changelog.file` is set) needs no configuration: each one detects what
it can from the repository (its base branch, package manager,
decision-record folder, documentation root) and falls back to generic
guidance where a repository has nothing to detect. They read
the fields the drive loop uses when present (`repository.base_branch`,
`gates.command`, `drive.validation_plan_command`,
`drive.change_areas_catalog`, `issue_tracker.*`, `review.bots`). Set one of
these only when detection picks the wrong thing:

```yaml
adr:
  directory: docs/adr                 # decision records; default: detected (docs/adr, doc/adr, docs/decisions, …)
  rules_file: docs/adr/rules.yaml     # machine-readable rules (Jig M5); default: detected, else none
descar:
  lint_command: "bun scripts/check-descarring-scars.ts"   # scar lint taking document paths; default: detected (M4's lint), else a manual read
promote_memory:
  lint_command: "<your memory lint> --dir {dir} --file {file}"   # exit 0 = clean; default: none
  target_dir: docs/retrospection      # where promoted pages go (YYYY/MM/ below it); default: docs/retrospection
fix_ci:
  regenerate_commands:                # commands that regenerate committed generated files CI checks; default: none
    - bun run generate:api
resolve_conflicts:
  generated:                          # files rebuilt, never hand-merged, on a conflict; default: the built-in lockfile table
    - paths: ["src/generated/**"]
      command: bun run generate
github_actions:
  conventions_doc: docs/ci.md         # the repository's workflow conventions; default: searched for, else generic guidance
design_brief:
  kit: docs/design-kit                # voice, colours and type, rubric, logo; default: detected, else the design-language document
  design_language: docs/design.md     # design-language document; default: detected
  prototypes: design/prototypes       # where finished design bundles land; default: ask
decide:
  policy_files: [AGENTS.md]           # files whose ## sections are standing policy; default: [AGENTS.md]
  rules_directory: .claude/rules      # conditional rules, one per .md file; default: .claude/rules
  glossary_file: CONTEXT.md           # canonical vocabulary (**Term**: / _Avoid_: lines); default: CONTEXT.md
  architect_agent: architect          # subagent that rules in phase 3; default: a briefed general-purpose subagent
  escalation_labels: [agent:architect]   # extra labels on an escalated issue, beside hitl; default: none
explain:
  figure_build_command: "<your figure build command>"   # builds one figure, given its stem; default: explainers have no figures
```

Every field, with its default and the detection behind it, is in the
[configuration reference](CONFIGURATION.md#procedure-skills).

`decide` and `explain` render with one shared sheet kit, which lives in
`decide`; `decide` also checks the prose of a decision request with a
Simplified Technical English linter, a TypeScript port of a third-party tool
(see its [README](skills/decide/scripts/ste-lint/README.md)).

`review` finds the decision rules through `adr`'s locator, and `fix-ci` runs
its validation plan through `drive-pr`'s round planner, so the plugin keeps
them together.

## Codex notes

- **Skills** work in Codex as in Claude Code. Codex does not fill in
  `${CLAUDE_SKILL_DIR}`; each `SKILL.md` tells the agent to substitute the
  skill's own directory.
- **The turn-budget hook runs once trusted.** Codex reads the plugin's
  `hooks/hooks.json` but skips a plugin's hooks until their current
  definition is trusted (`/hooks`), and asks again when a release changes
  them. Codex's transcript is not in the format the guard reads, so there it
  counts nothing and reports could not check once.
- **The `review-arbiter` agent is Claude Code only.** Codex plugins carry
  skills, MCP servers, apps and hooks, but not agents; Codex reads custom
  agents only from its own agent folders (`~/.codex/agents/` or a
  repository's `.codex/agents/`). In a Codex session, hand a contested
  finding to a subagent that is given
  [`agents/review-arbiter.md`](agents/review-arbiter.md) as its
  instructions, or define the arbiter once as a Codex custom agent from that
  file.
- **The drive's default pass command** starts Claude Code
  (`claude -p "/jig:drive-pr <PR>"`). To drive with Codex, put a Codex
  command after the `--` in the
  [start command](skills/drive-pr/README.md#how-to-start-it).

## Call a skill's scripts from repository code

Normally only the agent runs a skill's scripts. When a repository's own code
also needs them (for example a sibling skill that imports a shared module, or
a status board that runs `await-round.ts`), it must find the installed copy,
because the repository holds none. Look in this order and fail
with a clear message when none is found:

1. `JIG_SKILLS_DIR`, set by the caller (CI jobs and tests point it at
   a checkout of this repository's `plugin/skills`).
2. Claude Code: the entry with `"id": "jig@jig"` and
   `"scope": "user"` in `claude plugin list --json`: its `readFromFolder` when
   present (a plugin loaded in place from a local marketplace), otherwise its
   `installPath`; append `/skills` and check that the directory exists.
3. Codex: the `version` of `jig@jig` in `codex plugin list --json`,
   then `${CODEX_HOME:-~/.codex}/plugins/cache/jig/jig/<version>/skills`.

The modules more than one skill uses (the configuration reader, process
runner, retry and polling policies, cleanup registry, timing traces and YAML
parser) are in `shared/`, beside that `skills` directory.

Paths inside the cache change with each release, so never store them.

## Update, pin or remove

- **Update** to the latest release: `bun tools/plugin/setup.ts`, or by hand
  `claude plugin marketplace update jig && claude plugin update jig@jig --scope user`
  and `codex plugin marketplace upgrade jig && codex plugin add jig@jig`.
  A tool picks up a new release only when the plugin's `version` changes (see
  [release](#releases)). Claude Code can also update in the
  background: `/plugin` → **Marketplaces** → `jig` →
  **Enable auto-update**.
- **Pin** a machine to a release tag: add the marketplace at that tag,
  `claude plugin install jig --marketplace https://github.com/docomply/jig.git#v0.3.0`,
  or `codex plugin marketplace add https://github.com/docomply/jig.git --ref v0.3.0`.
  Versions are chosen per machine, not per repository: every repository on a
  machine uses the same release, so releases keep reading older configuration
  files unless [CHANGELOG.md](../CHANGELOG.md) says otherwise.
- **What `main` means:** both tools install from the default branch, but a
  machine only receives a change when `version` changes. Every merge that
  changes `plugin/` is therefore released as a new version, written by the
  release step on `main` from the pull request's change note (see
  [release](#releases)); otherwise two machines showing the same
  version can run different code.
- **Remove**: `claude plugin uninstall jig@jig` and
  `codex plugin remove jig@jig` (add
  `claude plugin marketplace remove jig` /
  `codex plugin marketplace remove jig` to forget the source too).

## Where it works

The plugin lives in each tool's user-level plugin directory
(`~/.claude/plugins/`, `~/.codex/plugins/`), so it applies wherever that tool
runs as you:

| Where | What to do |
|-------|------------|
| A terminal session in any clone or worktree | Nothing beyond the one-time install |
| Herdr, Conductor, or any tool that creates worktrees and starts sessions | Nothing: new workspaces are ordinary directories on a machine that has the plugin |
| `claude -p`, `codex exec`, scripts and loops | Nothing; plugins load in headless runs too |
| A container image or CI runner that runs an agent | Install at image build: run the install commands with git credentials available. For Claude Code, build a read-only *seed* with `CLAUDE_CODE_PLUGIN_CACHE_DIR=/opt/claude-seed claude plugin install jig --marketplace …`, set `CLAUDE_CODE_PLUGIN_SEED_DIR=/opt/claude-seed` at run time, and enable it with `enabledPlugins` ([details](https://code.claude.com/docs/en/plugins/org#seed-containers-and-ci)). For Codex, run the two install commands in the image, or copy `plugin/skills/*` to `/etc/codex/skills/` and `plugin/shared/` to `/etc/codex/shared/`: the scripts import the shared code from the folder beside the skills folder |
| CI jobs that only run tests and gates | Nothing: they do not need the skills |
| A runner that gives each session its own Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) | A user-level install lives in the default directory and is not seen there. Build a seed once (as for containers) and set `CLAUDE_CODE_PLUGIN_SEED_DIR` in the runner's environment; repositories enable the plugin through `enabledPlugins` in `.claude/settings.json` |
| A tool without plugin support | Copy or link every folder of `plugin/skills/` into that tool's user skill directory (for example `~/.claude/skills/` or `~/.agents/skills/`), side by side, and `plugin/shared/` into a `shared/` folder beside that directory (`~/.claude/shared/`, `~/.agents/shared/`): skills import scripts from their siblings and code from `shared/`, so one skill alone, or the skills without `shared/`, do not run. The command name is then the bare skill name |

## Troubleshooting

- **The skill is not in the `/` menu.** Run `bun tools/plugin/setup.ts --check`
  (or `claude plugin list` / `codex plugin list`). If it is installed, the
  session started before the install: run `/reload-plugins` (Claude Code) or
  start a new session.
- **Install fails with an authentication or "repository not found" error.**
  git could not read the private repository without a prompt. Run
  `gh auth login` and `gh auth setup-git`, then retry with the HTTPS address
  above. Check with `git ls-remote https://github.com/docomply/jig.git`.
- **"Jig configuration not found"** — the agent is working in a
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
plugin/shared/                           code more than one skill's scripts import
plugin/agents/<name>.md                  agents Claude Code loads (Codex: see Codex notes)
plugin/hooks/hooks.json                  the agent-runtime hooks both tools register
plugin/hooks/<name>.ts                   the hook scripts, each tested in hooks/__tests__/
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
`.config/jig.yaml`.

Why per machine rather than per repository: an agent tool lists the skills it
can see when a session starts. A skill installed into each worktree therefore
needs something to run in every new directory before the session starts, and
every tool creates directories differently; a skill installed once per machine
is already visible everywhere. The trade-off is that versions are chosen per
machine, so skills stay compatible with older configuration files wherever
they can; a change that needs a configuration edit is a breaking release (see
[release](#releases)), and the skill's first step names the edit.

The plugin also registers an [agent-runtime hook](../GLOSSARY.md), the
turn-budget guard (`hooks/turn-budget-guard.ts`): before every tool call it
counts the session's agentic turns off the transcript and, within 50 turns of
the runtime's cap of 1000, hands the agent a wrap-up instruction, so an
unattended session writes its handoff before the runtime aborts it. It reads
local files only, lets the call through whenever it cannot count (and says so
as a hook error), and is off with `JIG_TURN_BUDGET=0`; its knobs are in
[CONFIGURATION.md § Environment variables](CONFIGURATION.md#environment-variables)
and the practice is [M1's rung](../modules/M1-gates-enforcement-ladder/README.md#core-pieces).

## Releases

Every merged change to `plugin/` is released as a new version, tagged
`v<version>` and described in [CHANGELOG.md](../CHANGELOG.md). A release run
writes the waiting changes that ask for a release as one version, the largest
bump any of them asks for, so merges that landed before the run share a
version. Machines
receive the release on their next update. Repositories need no change
unless the changelog says so.

## Moving from the `groundwork` plugin

Up to 0.11.0 the plugin was called `groundwork` (`groundwork@groundwork`, with
`/groundwork:` commands). From 0.12.0 it is `jig@jig`, with `/jig:` commands.
**This is a clean break: no old name is read anywhere.** The old
configuration file, the `GROUNDWORK_*` variables and the old folders are
ignored without a notice, so each of them has to be moved by hand:

| Before | Now | What happens to the old one |
|--------|-----|-----------------------------|
| `.config/groundwork-overlay.yaml` | `.config/jig.yaml` | ignored; a skill reports the repository as unconfigured |
| `GROUNDWORK_*` variables | `JIG_*` | ignored |
| `~/.local/state/groundwork/drive-pr/` | `~/.local/state/jig/drive-pr/` | ignored; a drive starts from empty state |
| `~/.local/state/groundwork/dashboard/` | `~/.local/state/jig/dashboard/` | ignored |
| `~/.local/state/groundwork/verification-fit.jsonl` | `~/.local/state/jig/verification-fit.jsonl` | ignored; move the file to keep its history |
| `~/.cache/groundwork/gh-cache/` | `~/.cache/jig/gh-cache/` | ignored; the cache refills on its own |

**On each machine**, for both tools:

1. Stop the drives running there (`bun <drive-pr skill>/scripts/drives.ts`
   lists them; [Call a skill's scripts](#call-a-skills-scripts-from-repository-code)
   says where a skill's folder is). A running drive keeps the code it started
   with, and removing the old plugin deletes the scripts it calls.
2. From a checkout of this repository, run `bun tools/plugin/setup.ts`. It
   installs `jig@jig` and leaves the old plugin alone, so remove that by hand:
   `claude plugin uninstall groundwork@groundwork --scope user` and
   `claude plugin marketplace remove groundwork`, and for Codex
   `codex plugin remove groundwork@groundwork` and
   `codex plugin marketplace remove groundwork`.
3. To keep the history of the drives' state, move it:
   `bun <drive-pr skill>/scripts/migrate-state-dir.ts --from ~/.local/state/groundwork/drive-pr`.
   A machine that sets `DRIVE_PR_STATE_DIR` has nothing to move.
4. Rename any `GROUNDWORK_*` variables in shell profiles, launch agents and
   CI configuration to `JIG_*`.

**In each repository** that uses the plugin:

1. Rename the configuration file: `git mv .config/groundwork-overlay.yaml .config/jig.yaml`.
2. Change `/groundwork:` to `/jig:` in its instructions (`AGENTS.md`, skills,
   rules) and `groundwork:` to `jig:` where it names an agent.
3. Where `.claude/settings.json` enables the plugin by id
   (`enabledPlugins`), change `groundwork@groundwork` to `jig@jig`.
4. Code that [finds the installed skills](#call-a-skills-scripts-from-repository-code)
   looks for `JIG_SKILLS_DIR`, the id `jig@jig` and the cache folder
   `plugins/cache/jig/jig/` instead of the `groundwork` names.

## Moving off the per-worktree installer

Releases up to `v0.1.1-review-pilot` were installed into each worktree by an
installer rather than as a plugin. A repository still on one of those tags
moves to the plugin like this:

1. Rename `.config/groundwork-overlay.yaml` to `.config/jig.yaml`. If it
   sets `review.job_pattern`,
   also set `review.required_checks`, or set the pattern to `null`; the
   review skill refuses the file otherwise. `harness.*` fields are ignored:
   tools a skill needs beyond `git`, `gh` and `bun` go into the repository's
   permissions (`permissions.allow` in `.claude/settings.json`).
2. Remove the installer: `.groundwork/`, the links under `.claude/skills` and
   `.agents/skills`, its `postinstall` line, its git hook (a
   `.git/hooks/post-checkout` whose second line is
   `# groundwork:managed post-checkout`), its CI steps and its `.gitignore`
   block. Code that imported `.groundwork/lib/` or ran a script by its old
   path must [find the installed copy](#call-a-skills-scripts-from-repository-code)
   instead.
3. Rename `/resolve-review-comments` to `/jig:resolve-review-comments`
   in the repository's instructions, add the `AGENTS.md` section from
   [Configure a repository](#configure-a-repository), and install the plugin
   on each machine.
