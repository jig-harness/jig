# Jig's skills: the `jig` plugin

Agent procedures (*skills*) that many repositories use should have one
maintained source, so a fix reaches every repository at once and no copy drifts.
Without that, each repository carries its own copy of the same procedure, the
copies diverge, and every agent tool on every machine needs its own setup step
before a new working copy can use them.

Jig ships its skills as one **plugin**: an installable bundle that Claude
Code and Codex both understand. You install it **once per machine**. From then
on every repository, every [worktree](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) and every session on that
machine has the skills; creating a new worktree, workspace or clone needs no
step at all. Each repository keeps only its own values (its gate command,
reviewer names, issue team) in one configuration file, which the skills read
when they run.

The skills come in groups, each in the order its skills are used. The groups
say what a skill is; for the order work takes through them, from steering to a
closed epic, with the skill that owns each stage and the artifact it hands on,
see the [lifecycle map](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/README.md#the-lifecycle-map),
whose template a repository fills with its own owners. The
last column says how a skill connects to the others: what starts it, what it
runs, what it hands over to.

**Find your way.** `jig` says which skill a task needs and what comes after it, where the plugin's reference is, and how to report a Jig bug.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [jig](skills/jig/README.md) | Answers which skill fits a task and how the skills hand work on, from the reference installed with the plugin (these tables, the configuration reference, each skill's pages) and Jig's repository at the installed version's tag; when Jig itself is wrong, decides whether the fault is Jig's, searches for an existing issue, and drafts a bug report in the fields of Jig's bug form, with the repository's own names replaced, for a person to confirm before it is filed on jig-harness/jig | `/jig:jig` | Names the skill that does the work and hands over to it; sends a lesson that is not a defect to [reflect](skills/reflect/README.md), and in Jig's own repository files the bug through [file-issue](skills/file-issue/README.md) |

**Deliver a change.** One item of work, from the tracker to a merged pull request. `file-issue` puts the item on the tracker, labelled by the repository's label taxonomy; `do-item` opens the pull request and arms `drive-pr`, and `work-batch` does the same for several small issues closed in one pull request; `drive-pr` runs one `resolve-review-comments` pass per review round, works a conflict through `resolve-conflicts`, and repairs red CI in its own repair round; `fix-ci` is the repair by hand when no drive runs or its budget is spent; `operator` tells a person where a piece of work stands on the line and passes their commands to it. Each also works by hand.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [file-issue](skills/file-issue/README.md) | Files a new tracker issue from a discussion, or plans an existing one (re-labels it, splits it into sub-issues, records its relations): writes a durable issue body, derives the labels from the change's areas or its description, checks them against the repository's label taxonomy, and searches for a duplicate before anything is written; sweeps the open issues for one filed without a type, a priority or a size, and moves those facets from one store to another | `/jig:file-issue` | Writes through [do-item](skills/do-item/SKILL.md)'s tracker scripts, and files what do-item and [work-batch](skills/work-batch/README.md) later pick up; derives labels from [change-areas](skills/change-areas/README.md); holds the label-taxonomy lint and the label validator |
| [do-item](skills/do-item/SKILL.md) | Picks up one work item from whatever the tracker adapter reads (an issue tracker today, a plan file in future), routes it to the right agent, implements it, opens a pull request as the repository's pull-request policy says and starts `drive-pr` on it | `/jig:do-item` | Starts [drive-pr](skills/drive-pr/README.md) on the pull request it opens; runs its own pre-pull-request review in the same tiers as [review](skills/review/SKILL.md), plus each review skill its declared gates name; escalates a dilemma to [decide](skills/decide/SKILL.md) |
| [work-batch](skills/work-batch/README.md) | Groups several small, independent issues from one area of the code into one pull request, one commit each: proposes a ranked batch within a point budget, holds back every issue a sensitivity flag makes solo-only, claims the batch, opens the pull request and drives it once; after the merge, closes out every issue in it | `/jig:work-batch` | The batched form of [do-item](skills/do-item/SKILL.md), whose batch check suggests it; opens the pull request under do-item's pull-request policy and starts [drive-pr](skills/drive-pr/README.md) on it |
| [drive-pr](skills/drive-pr/README.md) | Runs a pull request's review rounds unattended until it reaches one named end state (converged, waiting on a human, conflicting, …); each round is a fresh agent process, so a long drive never depends on one session surviving | `/jig:drive-pr` | Started by [do-item](skills/do-item/SKILL.md); runs [resolve-review-comments](skills/resolve-review-comments/README.md) every review round; calls [resolve-conflicts](skills/resolve-conflicts/SKILL.md) when the branch conflicts; repairs red CI in its own repair round, with the repository's CI-repair skill if it has one |
| [resolve-review-comments](skills/resolve-review-comments/README.md) | Walks every unresolved pull-request review thread to an explicit outcome, fixes, verifies, and resolves; repeats until reviewers settle | `/jig:resolve-review-comments` | One review round of [drive-pr](skills/drive-pr/README.md); hands contested findings to the `review-arbiter` agent and design questions to [decide](skills/decide/SKILL.md) |
| [resolve-conflicts](skills/resolve-conflicts/README.md) | Resolves a stopped merge, rebase or cherry-pick: names each side by role, traces why each side changed, regenerates lockfiles and generated files (those the repository lists in its configuration or declares in its change-area catalog), records every decision in the commit message, checks that no change was silently dropped, verifies staged work belongs to the operation, and applies repository obligations to the whole resolved diff; replays past merges to report where they conflicted, why, and the change that removes each cause | `/jig:resolve-conflicts` | Runs in [drive-pr](skills/drive-pr/README.md)'s conflict round; [fix-ci](skills/fix-ci/SKILL.md) takes over for checks that fail after the merge |
| [fix-ci](skills/fix-ci/SKILL.md) | Fetches a failed CI run's log, sorts the errors, fixes them and verifies locally before pushing | `/jig:fix-ci` | The repair by hand when no [drive-pr](skills/drive-pr/README.md) drive is running or its CI-repair budget is spent; [github-actions](skills/github-actions/SKILL.md) reviews the fix when it changes a workflow |
| [operator](skills/operator/SKILL.md) | Answers a person's question about the line (where a pull request, item or follow-up stands, what waits on a person, what was said to a station) from [`jig ask`](#asking-a-station-where-it-stands), a status as one fixed card and anything else in sentences, and sends their command to a station (hold, release, drive, an answer to a parked question, a mailbox directive) with [`jig send`](#telling-a-station-what-to-do), only on their instruction and after showing them the dry run; holds no state of its own | `/jig:operator` | Reads and writes the records [do-item](skills/do-item/SKILL.md), [drive-pr](skills/drive-pr/README.md) and the follow-up leave and act on; hands the work of a station to that station's skill, and a question about how Jig works to [jig](skills/jig/README.md) |
| [steward](skills/steward/README.md) | Inspects stopped work and the assigned queue, proposes recoveries and missing facets, and frames what still needs a person; the next tick applies its records under existing guards | `/jig:steward` (dispatcher only) | Reads the dispatcher's digest, writes owner-local records, and sends recurring recoveries to [reflect](skills/reflect/README.md) |

**Review a change.** Check work against the repository's own standards before and during review: `change-areas` says what the change owes, `review` and `github-actions` check it.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [change-areas](skills/change-areas/README.md) | Resolves a change against the repository's change-area catalog: which areas it touches, which checks, reviews, tracker labels and post-deploy actions it owes, printed as JSON, GitHub Actions outputs or a path-filter spec; checks the catalog's schema and invariants | `/jig:change-areas` | Its JSON is the validation plan [drive-pr](skills/drive-pr/README.md), [review](skills/review/SKILL.md) and [fix-ci](skills/fix-ci/SKILL.md) read through `drive.validation_plan_command`; [review](skills/review/SKILL.md) resolves the catalog with it when no plan command is set |
| [review](skills/review/SKILL.md) | Reviews a diff, plan or pull request in tiers (pattern checks, contract checks, semantic review) against the repository's decision rules and change-area catalog | `/jig:review` | Its tiers are the ones [do-item](skills/do-item/SKILL.md)'s pre-pull-request gate runs; reads the rules [adr](skills/adr/SKILL.md) derives; posts none of its findings to the pull-request threads [resolve-review-comments](skills/resolve-review-comments/README.md) settles, which come from the pull request's own reviewers |
| [github-actions](skills/github-actions/SKILL.md) | Reviews GitHub Actions workflow changes for security, pinning, concurrency keys, caching and the repository's own workflow conventions | `/jig:github-actions` | The workflow-specific form of [review](skills/review/SKILL.md); sends a red CI run to [fix-ci](skills/fix-ci/SKILL.md) |

**Understand, decide and record.** Design-level work: learn how it works today, settle the question, challenge the requirements and the architecture, write the answer where the next session finds it.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [explain](skills/explain/SKILL.md) | Writes a cited, commit-dated explainer sheet (HTML and Markdown) of how part of the system works today | `/jig:explain` | Comes before [decide](skills/decide/SKILL.md) and shares its sheet kit; cites the records [adr](skills/adr/SKILL.md) keeps |
| [decide](skills/decide/SKILL.md) | Settles a technical dilemma: searches the repository's precedent first, then rules or escalates to a human with a cited decision sheet | `/jig:decide` | Called by [do-item](skills/do-item/SKILL.md) and [resolve-review-comments](skills/resolve-review-comments/README.md) when a call is architectural; routes an outcome that clears the bar to [adr](skills/adr/SKILL.md) |
| [adr](skills/adr/SKILL.md) | Creates, updates and checks architecture decision records and the machine-readable rules derived from them | `/jig:adr` | Records what [decide](skills/decide/SKILL.md) rules; its rules are what [review](skills/review/SKILL.md) checks against |
| [red-team](skills/red-team/README.md) | Reviews a requirements or architecture document adversarially: personas (a critical chief technology officer, a security auditor, a performance engineer, a cost optimizer and, for requirements, more who stand for the people who use and approve it) each read it in fresh context, and one report gives each persona's verdict and every finding with the passage, the risk and the question the author must answer; never edits the document | `/jig:red-team` | Questions the document from the standpoint of the people it affects, before any plan or code, where [review](skills/review/SKILL.md) checks the same document against the repository's standards and decisions: run both, since one does not replace the other; a dilemma a finding raises goes to [decide](skills/decide/SKILL.md), and the revised document gets a [descar](skills/descar/SKILL.md) pass before it is accepted |
| [design-brief-builder](skills/design-brief-builder/SKILL.md) | Assembles the numbered brief bundle for an external design session (Claude Design, so far), then merges and checks the returned bundle | `/jig:design-brief-builder` | Stands alone: the design-prototype station, ahead of the delivery skills |

**Learn from the work.** What a session learned about the scaffolding goes into a shared store; a person approves what changes; lasting lessons end up in the repository's own documents.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [reflect](skills/reflect/README.md) | Records what a session learned about the repository's scaffolding (instructions, skills, gates) in a store every repository shares: merges duplicates, names each finding's class, escalates a class that keeps recurring to one tracker issue. On only when the configuration has a `reflection` section | `/jig:reflect` | Offered at the end of a [drive-pr](skills/drive-pr/README.md) and by [do-item](skills/do-item/SKILL.md); its findings are what [review-reflections](skills/review-reflections/README.md) reads |
| [review-reflections](skills/review-reflections/README.md) | Turns the stored findings into changes a person approves: reconciles approved fixes with what merged, groups what recurred, proposes a change, deferral, dismissal or escalation per group, and records each decision | `/jig:review-reflections` | The second half of [reflect](skills/reflect/README.md): run it periodically, or when a class of finding keeps recurring |
| [promote-memory](skills/promote-memory/SKILL.md) | Turns an agent's private memory into a reviewed, shared document in the repository | `/jig:promote-memory` | Sends an architectural lesson to [adr](skills/adr/SKILL.md); a page it promotes gets a [descar](skills/descar/SKILL.md) pass before it becomes a permanent, approved document |
| [descar](skills/descar/SKILL.md) | Removes review history, correction ledgers and finished-work rows from a promoted document, keeping what a reader needs now | `/jig:descar` | The pass a page [promote-memory](skills/promote-memory/SKILL.md) promoted gets before it becomes a permanent, approved document; runs on any docs page before it is promoted |

**Inspect and analyse.** Tools that inspect the repository: `audit` records its findings; `code-stats` measures what it is made of; `docs` checks its docs tree; `changelog` keeps its changelog and version; `programmatic-execution` runs read-only analysis.

| Skill | What it does | Invoke as | Works with |
|-------|--------------|-----------|------------|
| [audit](skills/audit/README.md) | Audits the repository against Jig's practice modules: checks its `.config/jig.yaml` against the repository, scores every module's maturity criteria with evidence, and records the result in the repository so the next audit reports what changed | `/jig:audit` | Opens the pull request for an applied recommendation under [do-item](skills/do-item/SKILL.md)'s pull-request policy and offers [drive-pr](skills/drive-pr/README.md) on it |
| [code-stats](skills/code-stats/README.md) | Measures what the repository is made of: classifies every tracked file by area (what it is for), kind (what it is), language and module, counts its lines of code, and reports in the terminal, as JSON or as an interactive HTML report, with the share it could not classify. Detects without configuration; `.config/jig.yaml` corrects it, and `--explain` names the rule behind any file | `/jig:code-stats` | Stands alone for now; its JSON is meant as measured evidence for [audit](skills/audit/README.md) |
| [docs](skills/docs/README.md) | Checks a docs tree in one pass against the docs-governance module's gates (frontmatter schema, generated index, `last_updated` dates, review scars, deferrals), flags drafts left stale, and lists the documents the project's type calls for and the tree lacks; holds those gates for a repository's hooks and CI | `/jig:docs` | Sends the scars it reports to [descar](skills/descar/SKILL.md); finds the decision records [adr](skills/adr/SKILL.md) keeps |
| [changelog](skills/changelog/README.md) | Keeps a repository's changelog and version from change notes: each pull request adds a small note instead of editing the changelog, a release step writes the notes in after the merge, and the skill's commands check a branch and show the next release; a GitHub Action and workflow template run the check, the release and the tags in CI, and `/jig:changelog setup` walks through turning it on. On only where the repository's `.config/jig.yaml` sets `changelog.file` | `/jig:changelog` | Where it is on, [do-item](skills/do-item/SKILL.md) writes the note before it opens the pull request, [drive-pr](skills/drive-pr/SKILL.md) and [resolve-review-comments](skills/resolve-review-comments/SKILL.md) keep it true through review, and [resolve-conflicts](skills/resolve-conflicts/SKILL.md) converts a branch's changelog edits into a note before merging |
| [programmatic-execution](skills/programmatic-execution/SKILL.md) | Runs bulk read-only analysis as one script instead of many tool calls, so large outputs stay out of the conversation | `/jig:programmatic-execution` | Supports every other skill; none depends on it |

The plugin also ships agents (a [subagent](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is a separately prompted helper
that a skill hands a narrow job to):

| Agent | What it does | Available as |
|-------|--------------|--------------|
| [review-arbiter](agents/review-arbiter.md) | Rules on contested review findings the triage rubric cannot settle (fix now, reject, won't fix, defer or escalate to a human); reads code, never edits | `jig:review-arbiter` (Claude Code; see [Codex notes](#codex-notes)) |

Which of these parts are scripts with no model in them, which are a model
deciding, who owns each record the skills share and who notices when one
fails is mapped in [MECHANISMS.md](MECHANISMS.md), by mechanism rather than
by stage. Every record the plugin keeps, on the machine, in the working
tree, on the forge and on the tracker, with where it lives, who writes it
and what keeps two writers apart, is listed in [RECORDS.md](RECORDS.md), by
record.

Contents: [set up from an agent session](#set-up-from-an-agent-session) ·
[the `jig` command](#the-jig-command) ·
[machine resource collection](#machine-resource-collection) ·
[the dispatcher](#the-dispatcher) ·
[asking a station where it stands](#asking-a-station-where-it-stands) ·
[requirements](#requirements) ·
[install](#install-the-plugin) · [use](#use-a-skill) ·
[configure a repository](#configure-a-repository) ·
[drive loop and issue pickup](#the-drive-loop-and-issue-pickup) ·
[procedure skills](#the-procedure-skills) ·
[Codex notes](#codex-notes) ·
[update or remove](#update-pin-or-remove) ·
[release channels](#release-channels) ·
[where it works](#where-it-works) · [troubleshooting](#troubleshooting) ·
[how it works](#how-it-works) ·
[release](#releases) ·
[moving from the `groundwork` plugin](#moving-from-the-groundwork-plugin) ·
[moving off the per-worktree installer](#moving-off-the-per-worktree-installer)

## The `jig` command

The plugin also ships `jig`, a command line for the tools that run on the
machine rather than in a session. Its components are
[resource collection](#machine-resource-collection) (`jig gc`) and
[the dispatcher](#the-dispatcher) (`jig dispatch`), and the same commands
install, remove, report on and run each of them; `jig upgrade` and
`jig doctor` keep the plugin itself current and check it,
[`jig ask`](#asking-a-station-where-it-stands) says where a piece of work
stands, and [`jig send`](#telling-a-station-what-to-do) tells it what to do.
The first install runs
from the installed plugin copy, with trusted Bun startup, and puts `jig` on
`PATH`:

```sh
bun --no-env-file --config=<plugin>/gc/bunfig.toml <plugin>/jig.ts install --yes
```

Replace `<plugin>` with the absolute installed plugin path (`claude plugin
list --json` names it). Run it from the repository to register, or add
`--repo <path>`. After that, from any repository:

```sh
jig install   [COMPONENT...] [--repo <path>] [--no-upgrade] [--yes]
jig uninstall [COMPONENT...] [--repo <path>] [--machine] [--yes]
jig upgrade   [--claude | --codex] [--channel latest|stable] [--source <marketplace>] [--jobs-only] [--json]
jig upgrade   --scheduled [--claude-program=<path>] [--codex-program=<path>]
jig doctor    [COMPONENT...] [--json]
jig status    [COMPONENT...] [--json]
jig receipts  COMPONENT [<date> | <run-id>]
jig run       [COMPONENT...]
```

- **`jig install`** previews each component's scheduled job, and writes it
  with `--yes`. Without a component named, it installs resource collection,
  registering this repository (or `--repo`), and the dispatcher only when
  its [machine file](CONFIGURATION.md#the-machines-dispatch-file) exists: the
  dispatcher's timer starts drives on the accounts that file names, so on a
  machine without it the install says the dispatcher was skipped and why.
  Named (`jig install dispatch`), a component without its machine file is
  refused. It also writes the `jig` command, `~/.local/bin/jig`
  (`jig.cmd` on Windows), and says so when that directory is not on `PATH`.
  Windows has no scheduler for the jobs, so there `jig install` with no
  component named writes only `jig.cmd`: it registers no repository and
  schedules nothing. `--no-upgrade` opts the machine out of the timers'
  [automatic updates](#automatic-updates), writing `upgrade.enabled: false`
  to the user file (`~/.jig/jig.yaml`).
- **`jig uninstall`** removes this repository's entry in resource
  collection; the jobs stay while they serve other repositories. Resource
  collection's job goes with its last registration, unless receipts are
  kept; the dispatcher's stays until `--machine`.
  `--machine` removes each component's job as well, and, with no component
  named, the `jig` command too.
- **`jig upgrade`** updates the plugin in Claude Code and Codex, whichever
  is on `PATH`, to the newest release of the [channel](#release-channels)
  each follows, and installs it in one that lacks it (following `stable`,
  unless `--channel latest` says otherwise). Then the installed plugin copy,
  now the new release, refreshes what runs it: each installed job's
  launcher copy and its job (the systemd units, the launchd job or the
  crontab line), and the `jig` command's launcher copy and script, so a
  change to the launcher in a release reaches them. A job keeps the
  environment, schedule and programs its install recorded; only what the
  release writes differently changes, nothing is written where nothing
  differs, and a job that was enabled or running stays so. Every command
  that changes state is printed before it runs (read-only queries, such as
  a version or a plugin list, are not), and `--json` prints what became of each
  harness and job. In Claude Code it also refreshes each project- and
  local-scope install of the plugin from its directory, and removes from
  Claude Code's install record each whose directory no longer exists; one it
  cannot update safely it leaves as it was, saying why. `--jobs-only`
  refreshes the jobs and the command without updating the plugin, for after a tool updated it on its own. Each tool
  command is limited to `JIG_SETUP_TIMEOUT_SECONDS` (default 300).
  `--scheduled` is what the timers run before each job
  ([automatic updates](#automatic-updates)); it prints one line of JSON.
- **`jig doctor`** checks the machine and the repository it runs in, and
  names the command that fixes each failure: Bun's version against the one
  Jig tests; `claude` and `codex` resolving outside every git checkout (a
  job never records an agent tool inside one, so a development shim ahead
  of the real tool on `PATH` leaves the jobs without it); the plugin in
  each harness and the channel it follows; every project- and local-scope
  install of it in Claude Code, with its directory and version, failing
  one older than the user-scope install or whose directory is gone; the
  `jig` command's launcher
  copy; the latest scheduled upgrade, which fails while that upgrade failed,
  naming it and the agent tool's error; for each component, or those named, its machine file, its job's
  launcher copy against the installed plugin's, the programs its job names
  and its last run's receipt, and for the dispatcher that Orca resolves
  where its timer runs; and the audit's
  [configuration fit](skills/audit/README.md#what-it-does) of the
  repository, offline (the audit itself also reads the forge and the
  tracker). Outside a repository that check is skipped. It exits 1 when
  any check fails; `--json` prints every check. This checks installation and
  configuration, not individual drives. For a stopped driver or stranded CI
  hold, use `jig ask drive <PR>` in its repository, or the
  [drive doctor](skills/drive-pr/README.md#recovering-a-stranded-ci-hold).
- **`jig status`** says whether each component's job is installed, where,
  its schedule and next run, and its last run's receipt.
- **`jig receipts gc`** (or `dispatch`) lists the receipts of earlier runs;
  a date lists that day's, a run id prints that run. A run a timer started
  carries an `upgrade` line: what the scheduled upgrade before it came to.
- **`jig run`** runs now what each component's timer runs:
  `jig gc --scheduled` and `jig dispatch --apply`.

The `jig` command runs the launcher the scheduled jobs run, from its own copy
under `~/.local/state/jig/launcher/`: at each run it asks the agent tool
(`claude plugin list --json`, or `codex plugin list --json`) for the
installed plugin copy and runs that one, so a plugin update reaches `jig`
without a new install. It runs in your shell's environment, recording only
the paths of Bun and the agent tools, so run `jig install` again after
moving either. A file at `~/.local/bin/jig` that `jig install` did not
write is never replaced or removed. The component forms `jig gc install`,
`jig dispatch install`, `jig gc receipts` and `jig dispatch receipts` do
the same as the commands above and keep working, unlisted in the help.

`jig --help` (or `jig help <command>`) lists every command and its options,
and `jig completion bash`, `zsh`, `fish`, `pwsh` or `nu` prints a completion
script for that shell.

## Machine resource collection

`jig gc` reports registered machine-local leftovers and writes a receipt;
`jig gc --collect` removes what the evidence shows is finished, within the
bounds confirmed at install, and `jig install gc` registers a repository
and its daily job. Collecting runs use the install-recorded base
declaration and stay within the confirmed bounds. See
[resource collection](gc/README.md) for supported kinds and collection
limits, and [configuration](CONFIGURATION.md#gc) for both configuration
layers.

## The dispatcher

`jig dispatch` is the start of the [dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): a program
on the machine that runs the agent sessions, which looks at the tracker,
the pull requests and the running sessions, says which stage of the
delivery loop should be running and is not, and, when told to, restarts
the drives that stopped on something a machine can settle and tells a
person about the stops only a person can settle:

```sh
jig dispatch [--apply] [--repo <path>]... [--followup-since <date>] [--json]
```

`jig dispatch --help` lists its options, and `jig dispatch dashboard --help`,
`jig dispatch log --help`, `jig dispatch line --help`,
`jig dispatch clear --help` and `jig dispatch probe --help` list those of
each subcommand. For each
repository (`--repo`, else the machine file's, else the current one) it
prints every action it would take, each with the record that wants it and
the evidence: a pickup for an item assigned to the repository's factory
identity, a re-arm for a drive its
ledger shows stopped on a mechanical state (a usage limit, an answered
park), a re-drive for a converged drive gone stale (its pull request now
conflicts with its base, or its head moved past the head the drive
verified), for a drive that stopped on a conflict, or once per head for exit 12 (uncommitted work), a follow-up for a merge, a notification for a drive only a
person can settle. A converged pull request its base merely moved past,
still mergeable at the verified head, is left alone, and one whose
mergeability the forge is still computing is reported and waits for a
later run. A stage a running session or a launch record already holds is listed
as running; a record it cannot read, or a target it cannot place, is
reported and never planned. Each run writes a receipt under
`~/.local/state/jig/dispatch/receipts/`, which `jig receipts dispatch`
lists. What the dispatcher keeps between runs (the launch records, the
records that keep a notification or a nudge from going twice, and the
outcome log) is one SQLite database beside them, `state.sqlite`; a
database written by a newer plugin is refused, with its version named,
until the plugin is updated.

**`--apply`** starts what the machine file
([`~/.jig/dispatch.yaml`](CONFIGURATION.md#the-machines-dispatch-file))
enables for each repository: the `rearm` stage, and the `pickup`,
`followup`, `notify`, `steer` and `steward` stages below. With `rearm`, each re-arm
of a stopped drive, and each takeover of a wedged driver this machine
started (or another host did: see several hosts, below), or of a silent
driver no launch started that ran on this host and whose run this host
shows ended, or whose holder the clone's drive doctor (`drives.ts --json`)
reads `DEAD` or `WEDGED`,
runs as `drive.ts <PR> [--take-over] -- <pass>` in a terminal tab
of the pull request's workspace, opened from the pull request when none
holds it, through a small wrapper (`dispatch/run.ts`). The wrapper bills
the pass to an account the machine file lists, through that account's
configuration directory, and only while the account has a free slot and no
recorded usage-limit wall; before the launch the dispatcher checks that the
directory resolves to the account's identity, and starts nothing when it
does not. Every launch begins with a launch record in the state database,
so a launch whose answer is lost
holds its slot and is retried only under its own record. A refusal
`drive.ts` gives (another driver holds the pull request) is the stage's
answer and is not launched again on the same ledger facts. A re-arm that
ended on any other failing exit (a usage-limit wall excepted) without moving
its drive ledger (its attach
refused, say) is not launched again while the pull request's head, its
branch's head and the ledger's generation are those it launched at (the hold needs those heads recorded at
the launch and its branch's head readable now; when either is missing, the
next tick launches again): a person
is told once, and when the pull request is behind its branch (its head is not
the branch's), the notice names both commits and the recovery, closing and
reopening the pull request. A change of either head or of the ledger lets the
next tick re-arm it. A re-drive is
launched once per change: the drive merges the base in through its
conflict-resolve round, or reviews the new head in its ordinary rounds. A
converged drive's change is its pull request's head, conflicting or not. A
drive that stopped on a conflict (exit `9`) is re-driven once per pair of its
pull request's head and its base branch's head, whatever the forge reports of
it by then, and a person is told only when that re-drive leaves it stopped `9`
at the same pair; a head or a base that moves is a new attempt. A drive that
stalled (exit `14`) or whose CI-repair passes were spent (exit `21`) is
re-driven once per head commit, a stall that left work in its tree only in
that tree, and a person is told when the same head stops the same way again;
a stop a person is told of says so when its pull request also conflicts with
its base. A drive whose failing checks kept failing on the CI service's
infrastructure through its re-runs and head moves (exit `23`) is re-driven
once per stop, after a backoff from the stop that doubles with each such stop
in a row (15 minutes, at most 4 hours), and a person is told once 7 stand in a
row. A pass deadline that recurred past the drive's restarts (exit `15`)
is re-driven once per head commit too, one that left work in its tree only in
that tree, and a failure (exit `1`) while the
pull request conflicts with its base once per pair of its head and its base
branch's head, so its conflict-resolve round runs. These re-drives, the
takeover of a silent driver no launch started that this host shows gone
and the run again of a follow-up that died draw on the pull request's recovery budget, with the
re-arms of stops with no recorded cause: 3 in a rolling hour, after which a
person is told. The takeover of a
holder selected through the doctor-only fallback (`DEAD` or `WEDGED`), rather than host-confirmed recovery, is outside the budget. A record
claimed on this host before it last restarted has died, since a restart ends
every process, and its outcome row says so; hosts are told apart by the
[process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)'s
host id, so a renamed host is still this one. A record whose process cannot
be checked (claimed on another host, or the process table cannot be read)
holds its slot until a person clears it:

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch clear <record>
```

which clears only a record the tick cannot settle: an unknown one, a
pending one whose launch cannot be retried (a stuck one: both of its
launches went unanswered, a follow-up's replay could not be proven
safe, or a launch answered as started went unclaimed past the machine
file's `unclaimed_after`, which the tick notifies as needing a person), or one that does not read
and whose claim is not alive. It refuses a running record, readable or
not (stop its session first), and, among the records that read, an ended
or died one and a pending one whose launch can still be retried: those
the tick settles.

**The account picks the agent.** Each account in the machine file names its
`vendor`, and that decides the agent every session on it runs in: a re-arm
admitted on a `claude` account runs Claude Code's pass command with
`CLAUDE_CONFIG_DIR` set to the account's directory, one on a `codex` account
runs Codex's documented pass command
([drive-pr](skills/drive-pr/README.md#how-to-start-it)) with `CODEX_HOME`
set to it, and in either the other directory variable and every credential
variable (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
are removed, so a drive stopped on a Claude Code account's usage limit is
re-armed on a Codex account at the next run. A repository never names an
agent: it names a model per runtime in `routing.models`, which a pass reads
for its vendor (the standard tier of `routing.models.codex` for a Codex
pass, `drive.pass_model` for Claude Code's) and a pickup reads through its
route. Every drive runs under the pass deadline the run read
(`DRIVE_PR_PASS_TIMEOUT` in its environment, else the drive's 90 minutes),
written on its launch record and handed to `drive.ts` as `--pass-timeout`.
A Codex pass has no turn cap of its own, so a `codex` account is not
admitted for a drive while that deadline is `0`. A `codex` account is admitted
for any launch only on a host that set
[`drive.codex_bypass`](CONFIGURATION.md#a-hosts-opt-in-to-bypass): a pass needs
that bypass to push, and nobody is there to approve. An account of any other
vendor, which the drive documents no pass command for, is accepted by the
machine file and never admitted. Each run reports these at its top
(`accepted, not admitted`, with the reason) and in its receipt
(`accountsNotAdmitted`). The `review-arbiter` agent stays Claude Code's;
the turn-budget hook counts responses in both runtimes
([Codex notes](#codex-notes)).

**Pickups** (the `pickup` stage) start headless `do-item` passes for
items assigned to the factory identity in a dispatch state, and for the
people the host's machine file names under `serve:`. A served person's
open, not-started assignments need no dispatch state. Unassigned items
under an epic assigned to them inherit that person, including nested
epics. Only assignments made by a repository writer qualify.

Served people's assignments are read from the tracker team, which several
repositories may share, so each repository's tick sees the same list. A served
item that carries another repository's label (one of `review.taxonomy.repos`
other than this repository's `review.repo_label`) is left to that repository's
checkout: it is not wanted here and not reported as held, and the launch-time
recheck refuses it too. An item that also carries this repository's label
stays startable here; without both settings nothing is left out.

An item that carries none of the taxonomy's repository labels belongs to no
repository yet. On a tracker several repositories share (Linear, Jira) the
machine file's `serve_defaults` names one repository per tracker namespace to start
such items; every other repository leaves them alone, and the launch-time
recheck refuses them there. For a team with no default the item is started by
none and reported once, with its hold reason, as needing a repository label,
which a person settles by labelling it; the Queue view shows the hold, and no
notification goes out. A repository whose tracker team no other repository
shares still needs a default for it once it has the scope. A GitHub repository
reading its own issues needs no label, since its tracker is already its own.

A served item held only by open blockers starts its blockers instead of
waiting on work nobody does: an open, not-started, unassigned blocker of this
repository's scope, with no `hitl`, `manual-ops` or `jig:hold`, and no epic, is
picked up first (to three links from the assigned item), claimed with
`tracker.ts claim --for <person> --blocking <item>` and assigned to the person.
A blocker assigned to someone else, in progress, held, an epic or another
repository's is never taken: the item stays waiting and names it with its
reason. GitHub Issues adds the person rather than replacing an assignee, then
checks that the resulting assignee list contains only that person; a concurrent
assignee makes the pickup refuse without restoring anyone. Linear and Jira
have one assignee, so they assign first and verify the assignment from history;
when that check finds a concurrent assignee was replaced, they conditionally
make a best-effort restoration and refuse the pickup. A tracker without either
operation leaves the blocker for a person to assign. An assigned epic without an execution plan works one child at a time,
none while a child of it is in progress; an epic none of whose open children
can start reports one reason.

The Queue view names holds: an open blocker reads "waiting on #N" (with
"picked up first" or why it was left);
`hitl`, `hitl:*`, `manual-ops` and `jig:hold` read "needs a person to start".
Eligible items are ranked by priority, the work they unblock, epic order,
size and age. Assignment provenance, relations and children are cached
until the item's update time changes. Served forge logins also join the
pull-request adoption authors.

A served queue costs the tracker a handful of requests a tick. On Linear,
one paged query reads a person's assignments with each one's relations
(and the related issue's state) and its parent (with its description); the
issues the walk still needs by key, such as an execution plan's steps,
leave together in one lookup. The reading is kept between ticks, and a
tick first asks the tracker, in one request, whether any issue it depended
on, any child of one, or any issue newly assigned to the person changed
since: when nothing did, the tick reuses the reading whole, and when
something did, it reads the queue again and only the issues that changed.
The reading is taken whole every 15 minutes regardless, and a tick with no
free slot reuses one younger than that without asking. Every repository of
the machine file that names the same tracker, team and person shares one
reading per tick.

Every process on the host shares each tracker credential's request budget
(`tracker_share` in [the machine's dispatch file](CONFIGURATION.md#the-machines-dispatch-file)).
While the tracker refuses the credential for its rate limit, no request
leaves the host before the reset it named: a tick reports the tracker once
as rate limited until then, the queue it shows is the last reading, and
the pickups it would launch wait.

Before launching, the tick rechecks the item and admits an account. The
pass runs through the account-bound wrapper under `dispatch.pickup_deadline`;
it keeps the orchestrator's model and effort and forwards the item's route
to its implementer. Its prompt ends by asking the session to record
how it ended, `jig dispatch result <record> <token> done|failed`, which
refuses another record's token and a second answer. A completed pickup adds
`--pr <number>` for the pull request it opened, or `--none "<reason>"` when
no pull request was needed. A `done` without either is refused. A pickup the
tracker's rate limit stopped before it claimed the item (a tracker script
exits `5`) records `waits --until <time>` instead (after the claim the pass
waits for the reset within its deadline, else records `failed`): the item is held until that time, with no
question for a person, and the first tick after it launches the item again. A pickup
whose claim the repository's start rules (`do_item.preflight_command`)
refused records `failed --refused <updated-at> --reason <reason>`, and the dispatcher
shows the item as held with that reason until the item changes. A batch
pickup names each refused member with `--key <item>` beside its `--refused`:
only those members are held, each until it changes, and the rest of the
batch is picked up again without them. Every ended
launch's outcome keeps its next owner: a station address, a person and their
act, or nobody with a reason. `jig ask` shows this as `last.next`; older
outcomes that did not keep it say it was not recorded. A converged drive
hands to a repository maintainer to merge, and a completed follow-up hands
to nobody. The session holds its
slot while the runtime reports its agent working or waiting, and gives it
back when the agent finishes. `do-item` claims the item itself
(`tracker.ts claim`: refused when the item is already in progress or
assigned to someone else, and abandoned when a re-read shows another claim
landed first), so the tick never writes to the tracker. Hosts that serve
one person, or pick up from one queue, claim with the same identity, so
only the claim marker tells their claims apart: with
`do_item.claim_marker` set, of two hosts claiming one item the one whose
marker is earliest claims it and the other refuses, usually with nothing
written (best effort: a lagging listing can let both win, and a later loss
stands a claim down after its writes)
([do-item's start rules](skills/do-item/README.md#the-repositorys-own-start-rules)).
Without it, claims serialize on one host only. A claimed item
with no running session for longer than `dispatch.stalled_after` is
reported as stalled and never relaunched (a served person's item only when
a pickup of the host claimed it: the rest of their work in progress is
their own); an item more than one running
session joins to is reported as a double claim; a session waiting longer
than `dispatch.blocked_after` is reported.

A pickup starts only where the session runtime binds the pass to the
account it bills. On Orca it runs through the headless wrapper used by
follow-ups, with the admitted account's configuration directory and an
identity check before launch. An interactive launch remains unavailable
until the runtime can bind it to an account.

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch result <record> <token> done|failed [--pr <number> | --none <reason>]
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch result <record> <token> waits --until <time>
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch result <record> <token> failed --decision <file>
```

#### Every need is a decision

A pass that stops for a person frames what it asks, as a drive frames a
park: it writes a `parked-decision/v1` record (the question, two or more
options each with what it changes and costs, the one it recommends and
why, the class, the steps a person must take and what it already did) and
records `failed --decision <file>`, which checks the record as a park's is
and keeps it with the result; a record the check refuses records nothing,
so the pass fixes it and sends it again. The need it raises (a failed
follow-up, a pickup's question) carries that decision. For what the tick
finds itself it frames the decision from the facts that identify it, with
options it can carry out, each set ending with **Leave it to me** (no step,
and the need leaves Needs you until its facts change):

| Need | Key | The other options, and what the tick does |
| --- | --- | --- |
| a failed follow-up, or a stale claim again | `followup` | **Run it again**: deletes the follow-up's marker, so a later tick starts it again with your note in its prompt; **Record it done**: marks the existing marker done in place |
| a stalled pickup, or a pickup's question it did not frame | `pickup` | **Release the claim**: moves the item back to the first state a pickup starts from, so a later tick picks it up afresh |
| a checkout the workspace runtime does not list holds the launch's branch | `checkout` | **Detach the checkout**: detaches it at its commit, only when it is idle (clean, its commits on the remote, no drive or process in it) |
| a drive handed to a person, or stopped with no cause | `drive` | **Re-arm the drive**: adds the `rearm` label |
| a launch record stuck pending | `launch` | **Clear the record**: as `jig dispatch clear` does |

A double claim, an unanswered nudge and an item assigned by someone who
cannot write keep their free text. Answer a need's decision as a park is
answered, in a comment on its pull request or forge issue (`answer
followup: approve [<digest>]`), copied from the dashboard or sent with
`jig send followup@owner/name#456 answer followup --approve --decision
<digest>`. The tick of the host that owns the repository reads the
comments each tick, counts an answer only from an author the forge
vouches for, never its own login, and only when it names the decision's
current digest and every person who answered chose the same option, then
carries out the option once: it checks again that the step still may run
(the stage is on, no hold label, the marker unchanged, no session holds the
work, no open pull request carries the item, the checkout idle) and
otherwise refuses with the reason, which the need shows; answering again
tries again. A decision a pass framed starts that stage again (the
follow-up's marker deleted, or the item released), and the session started
next is handed the option you chose, narrowed by your note. Answers on an
item of a tracker other than the forge are not read yet.

**The steward** (the `steward` stage, with `steward.enabled: true` in the
machine file) inspects what the rules leave stopped, under the owner host's
account and load admission. Every 20 minutes, only when the digest changed,
it can propose a transient-stop retry, a missing issue facet, queue tie order
and the act and ask for a human need. It can also propose one fixed resume of
an ended dispatched pass that recommended an option outside the human-decision
registry. The follow-up lane's own routine retry runs first. The next tick
applies its closed records under the current holds and recovery budget;
the steward itself launches nothing. It never answers a registry park or
re-arms a drive a person stopped. A pass lasts at most 15 minutes, uses the
admitted vendor's complex-tier model, and runs at most three times an hour.
Its digest and records stay in the owner's state database. A recovery class
re-armed three times in a week proposes a reflection rule.
See [steward](skills/steward/README.md) for setup and record boundaries.

**Follow-ups** (the `followup` stage) start one headless pass per pull
request merged since the stage was switched on (`followup_since`), running
the repository's `dispatch.followup_command` on it (`/followup` in Jig) in
the pull request's workspace. Follow-ups open their workspaces in a lane of
their own: at most `followup_opens_per_tick` a tick (2 by default), beside
the drive launches' `opens_per_tick` and the notices workspace's reserved
open, with at most `followup_concurrency` passes (2) running on the host at
once, so a follow-up never waits for a drive's launch and a drive's launch
never waits behind follow-ups. They share the accounts' slots. A follow-up
that waits says on what: the lane's budget, the lane's cap or the accounts.
The pass runs as a drive's pass does: in a
terminal tab running the dispatcher's wrapper, as the account's vendor's
non-interactive command (`claude -p`, `codex exec`), bound to the admitted
account through its configuration directory, under the pass deadline, and
with the host's own permission settings (`drive.pass_args`, and
`drive.codex_bypass` for a Codex account; see
[a host's opt-in](CONFIGURATION.md#a-hosts-opt-in-to-bypass)), never with
one the dispatcher adds. So it starts on Orca, which cannot yet bind an
interactive session to an account. A hidden-marker comment on the merged
pull request is the claim: the dispatcher posts one naming its launch
record before it starts the pass, reads the markers back, and stands down
when an earlier one is there. A follow-up a person runs by hand claims the
same way, marks its marker done once it succeeded, which also sets the
pull request's `jig:followed-up` state label, and says it failed with
`marker failed`, which sets `jig:followup-failed` and leaves the marker
claiming the follow-up; since that label is all `marker failed` records,
it exits `1` when the label is not written, and says it recorded nothing
where the labels are off:

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch marker claim <PR> [--repo owner/name]
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch marker check <PR> --comment <id> [--repo owner/name]
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch marker done <PR> --comment <id> [--repo owner/name]
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch marker failed <PR> --comment <id> [--repo owner/name]
```

`claim` exits `3` when an earlier marker holds the follow-up, and `check`
does when one has appeared since, so the run stops before it acts. Only a
marker written by the dispatcher's own login or by an owner, member or
collaborator counts. When a dispatched follow-up's pass ends, its wrapper
writes the result onto the marker (`outcome: done` or `failed`), where
another host reads it, and the next run writes it there when the wrapper
could not; the wrapper then sets the pull request's state label
(`jig:followed-up` or `jig:followup-failed`) where the labels are on, and
the result is also kept in an outcome record per pull request
that never expires. A follow-up that failed, or whose marker names a
launch record this machine no longer has and carries no answer, is notified
and never started again: delete its marker to have it run again. A pass that
died during its work (its wrapper gone, or a signal or a failing exit) with
no result and no question is run again once: the tick releases its marker,
answered or not, and a later tick starts the follow-up again, within the pull
request's recovery budget, while the death is under 6 hours old; a second
death is notified. A pass that cannot finish without a person stops and
ends its output with a line starting `Question:`; the notification carries
that question, and the outcome log counts it as parked for a person. A
question that is only one of the dispatcher's fixed **routine question
classes** carries the class's tag, and such a follow-up is run again once,
within the same budget, with the class's standing answer in its prompt:

| Tag | The question | The standing answer |
|---|---|---|
| `local-leftover` | a local branch or worktree the pass may not delete without asking | keep it, list it |
| `person-owed` | who takes, authorizes or scopes a step only a person can: a live check, a rollout to another repository, an organization's setting, an operational action, a failed release gate | take none of it; report it as owed and file one item for it in this repository's tracker |
| `drafted-items` | whether to file the follow-up items the pass drafted itself | file them as drafted |

Each answer ends with finishing the other arms and recording done. A step
only a person can take is no reason to stop in the first place: the pass
reports it as owed, files it, and counts the arm settled; unlike a death's run again, it has no 6-hour age limit. A follow-up
that failed before passes tagged their questions is run again once with
every class's standing answer; an outcome whose retry evidence the dispatcher
kept needs no launch record, while an older one needs its record still on the
host, and is notified once the record is gone (past `receipts_days`). An untagged
question, or a failure of the run again, is notified; a follow-up is never
run again more than once by a death and a routine question together.

A Claude follow-up that exits unsuccessfully within a minute without a
result, a question or its own transcript is treated as unable to start.
Its account stays out of admission for `wall_backoff`, and its marker is
released by a tick that still has the pull request in scope and undisputed,
so a later tick can retry on another account. The
outcome log says `quota wall` when the vendor printed a recognized usage
notice, otherwise `refused` with the startup reason. A transcript that exists
or cannot be checked keeps the ordinary failure classification. This retry
does not consume the stale-claim release described below.

A claim no run will finish does not hold a follow-up for good. A marker a
person's run posted and never marked done, or another host's with no
answer, that is older than `dispatch.followup_stale_after` (a day by
default) with no session joined to its pull request is released: the host
that owns the repository deletes it, once per pull request, and the next run
starts the follow-up again. The report says whose claim it was, how old, and
the window. A claim on the same pull request that goes stale again after
that is not released a second time: it is notified to a person, with its
age and whose claim it is, to mark done or delete.

**Notifications** (the `notify` stage) reach a person for each cause: a drive
parked with a decision unanswered, carrying the drive's framed decision for
each one; a drive stopped on an exit only a person settles, or with no exit; a
re-arm that failed without moving its ledger, with the close-and-reopen
recovery where the pull request is behind its branch;
a failed follow-up, with the question its pass stopped on; a stalled pickup,
a double claim, a session waiting past `dispatch.blocked_after`; and a
pull request that enters Ready to merge. Each message
carries the cause or the question, the pull request's link and the handoff,
and names the workspace the stage ran in.

**Ready to merge.** Each tick places every converged pull request, through
one predicate the merge-ready announcement and `jig ask` share, in a lane:
**merge now**, with a merge command pinned to the head the drive verified;
**approve first**, naming the reviewers asked, or that nobody is, and saying
the repository's other protection rules are not read; or **update next**,
one pull request per repository behind its base. Merge now never rests on
the drive's ledger alone: the forge must witness a review of the head (the
reviewer app's check run, `review.reviewer_app`, or a person's approval
where no app is named), and a pull request from outside the repository
needs a person's approval. One that fails a condition goes where its reason
says, with the act that settles it. The facts come from a board read of its
own in the tick's observe phase, under a 30-second deadline per repository
and skipped while less than a fifth of the forge's hourly budget is left; a
board read that fails marks the list not read and changes nothing the tick
launches. A pull request entering merge now or approve first is notified
once per head, with its repository, number and lane only. The tick's
receipt (`board`) and the dashboard's line (`ready`) carry the lanes. Follow-up passes leave routine
local branch, retired-workspace and scratch-note retention to periodic
cleanup, including leftovers no collector covers yet. These do not require
a question for a person or a failed result; evidence of unlanded work or an
active operational problem still does require follow-up. Every message for a repository
goes to one place a person watches, never to the workspace joined to the
pull request or item, which a person following many repositories does not
visit: the workspace on the branch `dispatch.notices_branch` names, when the
repository names one (the tick never opens or removes that one, and a
message waits while it is not open), else the repository's notices
workspace. With Orca the message becomes that workspace's comment, and the
workspace is marked unread, which Orca's phone app shows. A message that
still stands `dispatch.renotify_after` (a day by default) after it was last
sent is sent again, saying since when it has waited, until its cause goes;
`0s` sends each one once. The dispatch dashboard lists the same causes,
each with how long it has waited. The notices workspace is a branch of the default
branch (`jig-dispatch-notices`), named `⚙ dispatched · notices`, into which
no agent is launched, in which the repository's create hook does not run, and whose first terminal is closed. If that close fails,
the tick reports the failure in its receipt while still delivering the
notification. Inspect the workspace's terminals, then close the idle initial
shell through Orca. Later ticks never retry closing all terminals, since a
person may have started work there. The notices
workspace stays only while it has a job: once it has been read for
`dispatch.notices_linger` (an hour by default), or every cause it carries
is gone while it is still unread, the next tick removes it with its branch,
unless it holds something of a person's (a comment of their own, an agent,
changes or a commit of their own). Retirement compares the complete comment
with the dispatcher-only text it last wrote and read back; appending personal
notes preserves the workspace even when the notification key remains. A
workspace whose comment predates that record is left for a person. The runtime
refreshes the workspace identity, branch, agents, terminals and Git checks
under the removal deadline; the next message that needs it opens it
again. A message
counts as sent only once the workspace's comment, read back, carries its key
line (`[jig dispatch: …]`), and is not sent again while its cause stands
until `renotify_after` has passed;
while a workspace is still unread, a new message is appended to its comment
rather than replacing it. The answer to a park is never sent back through
the notification: it is a comment on the pull request with a line
`answer <key>: …`, and the next tick re-arms the drive.

**Several hosts** may dispatch one repository: it may be listed in the machine files of several hosts, each
dispatching it with its own accounts. They coordinate through
[shared records](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
on the forge (`records.shared: forge`, the only medium today): before a host
launches a drive it posts a launch claim on the pull request, a hidden-marker
comment naming its launch record and the host, beside the launch record, and
a follow-up's claim is its marker, which now names its host too. A launch's
end is on its claim as soon as the launch ends: the wrapper that ran it
writes the end right after it records the exit. A write the forge refuses
is one line on the wrapper's output; then, as for a wrapper killed before
its write, the host's next `--apply` run writes the end instead.
Every run reads every host's claims: a launch another host's claim holds is
reported as held by that host and never started twice; a refusal, a re-drive
of the same change or an arm at the same head another host made counts as
this host's would; a follow-up another host ran reads as done or failed once
that host wrote its answer; and a driver another host started whose ledger
heartbeat is past the lease window is taken over from here, as the ledger's
own rule allows. A claim alone never starts a takeover. A pickup needs no
claim of its own here: `do-item`'s claim on the tracker item is the shared
record every host reads. Each run's report names this host (a digest of its
dispatcher's database, so a public comment names no machine), which host
owns the repository, and how many shared reads and writes the run made, with
the forge budget left after them.

One host owns each repository: its entry in the machine file says
`owner: true`, the default, so a single machine is unchanged apart from one
claim comment per drive launch and the answer written onto each follow-up's
marker. Every other host listing it sets `owner: false`, and then launches,
re-arms, re-drives and takes over through the shared records as the owner
does, but never notifies for the repository, never writes its dispatch
labels and never writes outcome-log rows for what it did not launch, so each
of those is written once; a run that finds another host's claims saying it
owns the repository too says so. Two consequences of `owner: false`: a session
it launched that waits or drifts is reported on that host and notified by
nobody, and its dashboard shows only its own launches. Every host needs the
same release.

These claims coordinate launches and never authorize an act a person takes.
The forge offers no conditional create for a comment, so two hosts whose
read-backs both lag can each read themselves the holder of one launch; the
stage's own refusal (the drive's lock and its ledger claim, `do-item`'s
claim, a follow-up's check before each act) is the backstop. A driver taken
over from another host is stopped there only when it notices the takeover,
so a wedged one keeps that host's account slot until its process ends.

**What it starts is named as the dispatcher's**, so a person tells it from
their own work at a glance on the board. A workspace the dispatcher creates
is named for the stage and the key (`⚙ dispatched · pickup #123`,
`⚙ dispatched · rearm #456`, `⚙ dispatched · followup #789`; with Orca,
the folder's name follows it, while the branch stays the one the branch
rule names), and its comment carries the
[dispatched mark](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
that name and the launch record's id (`⚙ dispatched · rearm #456 · launch
<id>`). A workspace it reuses keeps its name, and the mark is added to its
comment, once, on a line of its own after what the comment holds (a later
launch's mark replaces an earlier one's for the same stage and key). Each
session's terminal tab reads `jig dispatch · <stage> <key>`, and closes
when its run ends with nothing for a person: a drive's exit that is not a
park or a failure, a session that recorded `done`. A run that needs a
person keeps its tab, and the next launch for the same pull request or item
closes an earlier one of its own that is idle. A session may
rename its workspace to what the work became; the mark outlives the name,
since the launch record keeps it too and a notification that rewrites the
comment keeps it, and the morning report (`drives.ts --report`) lists the
workspaces the dispatcher launched into by the mark on their launch records,
each with the name it carries now.

A drive stopped with exit 12 gets one recovery pass per head commit in its existing branch tree. The pass inspects the uncommitted work and commits and pushes what belongs to the change, discards only known disposable work, or stops for unclear ownership. A missing tree is reported; no replacement tree is opened. A second exit 12 at the same head waits for a person, whose notice names `jig send drive@owner/name#N rearm`.

**Pull request state labels** (`dispatch.labels` in the repository's
[configuration](CONFIGURATION.md#dispatch), off by default) show where each
driven pull request stands, from any forge client, and let a person steer
the same way. Each pull request carries one state label (`jig:driving`,
`jig:converged`, `jig:parked`, `jig:stale`, `jig:held`, `jig:followed-up`,
`jig:followup-failed` under the default prefix), projected from its drive
ledger by one mapping its writers share, each writing when what it owns
changes: the drive itself when it arms (`jig:driving`) and when it stops,
by the exit table it shares with the dispatcher (`jig:converged` at the
head it verified; `jig:parked` for a park, a stop a person settles or
made, and a stop the dispatcher re-drives, which a run turns into
`jig:stale`), the follow-up when it ends, done or failed, whoever
runs it, and the dispatcher's every `--apply` run, which also writes
`jig:stale` and `jig:held` (from the serialized areas below) and corrects
any label that disagrees, so a label changed by hand, or left behind by a
drive that was killed, comes back. A drive's and a follow-up's writes need
no dispatcher: a repository that only drives pull requests gets the labels
too. Every writer reads `dispatch.labels` from the default branch, so all
of them use one prefix. A run re-reads a pull request's ledger just before
it writes, and leaves one whose ledger changed since it read it to a later
run; no state label is ever read to decide what to start. The command
labels are a person's commands, which the dispatcher reads and never
adds: `jig:drive` on a pull request with no drive ledger arms a drive on
it (the `rearm` stage, once per head commit) and is replaced by the state
label once the ledger exists. `jig:rearm` asks to restart a stopped drive in its existing branch tree, on an admitted account, and is consumed after launch; it never restarts a running drive or one a person stopped. `jig:hold` keeps every stage off the
pull request while it is there, reported at every run and removed only by
a person. Marker labels without the prefix sit beside the set: the
repository's manual-operations label (`issue_tracker.labels.manual_ops`,
`manual-ops` by default) on a pull request whose
`## Out-of-tree follow-ups` section lists a step not yet checked off, set
from the description at every run and kept after the merge until the
follow-up is done (a merged pull request is read only where
`followup_command` is set); and `automation` on a pull request a bot opened
that carries no label of the `automation:` family a repository's workflows
apply (`automation:docs-sync`), unless the bot is one the adoption rule
names, which is the host's own identity. The dispatcher never removes `automation`
or an `automation:` label, and never puts either on a person's pull
request. With `only_labeled`, the dispatcher reads only the pull requests
that carry a label of the set, which includes one a drive armed by hand
has labelled `jig:driving`; `jig:hold` keeps such a pull request out. The labels must exist first, and no writer
creates one: `jig dispatch labels [--repo <path>] [--yes]` lists the missing
ones, the marker labels with them, with no job installed, and with `--yes`
names each it created and lists the rest with the command a person who may
create labels runs; `jig install dispatch --repo <path>` does the same
beside the timer. A label write the forge refuses is reported (in the
receipt, or on the drive's or the command's output) and fails nothing, except
`jig dispatch marker failed`, which exits `1` when it cannot write its enabled
label, since that label is its only record of the failure. An
optional workflow, drive-pr's
[`templates/github/state-labels.yml`](skills/drive-pr/templates/github/state-labels.yml),
replaces `jig:converged` with `jig:stale` on a push to the pull request,
without waiting for a run.

**Adoption** (`dispatch.adopt` in the repository's
[configuration](CONFIGURATION.md#dispatch), off by default) drives the
repository's own recent pull requests without a label: an open pull
request with no drive ledger, opened by one of the rule's authors (by
default the login the dispatcher reads the forge as) and updated within
its window (a week by default), draft or not, is armed as if it carried
`jig:drive`, once per head commit. A bot's pull request is adopted only
when the rule names the bot, and one carrying `jig:hold` never is. An
automation pull request (a bot's the rule does not name, or one carrying
`automation` or an `automation:` label) is adopted, re-driven, taken over
or re-armed of the dispatcher's own accord only while it needs work: a
failed check (not a cancelled one or one waiting for approval), a conflict
with its base, or an unresolved review thread. A healthy one is left for a
person to merge; `jig:drive` or `jig:rearm` still drives one on request. Each
run reports every pull request the rule adopted, with the reason.

**Serialized areas.** Some pull requests conflict with each other whenever
two move at once: two migrations, two edits to one schema. An area of the
repository's [change-area catalog](skills/change-areas/README.md#the-catalog)
marked `serialize: true` has its pull requests driven one at a time. Each
run reads the catalog from the default branch, as it reads the `dispatch`
section, and each open pull request's changed files from the forge; the
pull requests whose files match a serialized area's own globs make its
group, ordered by how close each is to merge, from the ledger and the
forge alone: converged and mergeable first, then a drive in progress, then
the fewest unresolved review threads, then the most rounds, then the
oldest. The first leads and is planned as any pull request is; the rest
get no re-arm, takeover or re-drive, are reported as
`held: serialized behind #N in <area>`, carry `jig:held` where the labels
are on, and leave an event row in the outcome log when each hold begins
and ends, the end with how long it waited, so the dashboard shows what
contention cost. When the leader merges or leaves the group, the next run
promotes the next, which a conflict with the new base re-drives once. A
pull request in two serialized areas waits unless it leads both. Only the
dispatcher's own launches wait: a drive a person arms on a held pull
request runs, and the run reports that the group has two drives. The run
never adds an area: the conflict report proposes them
(`history.ts --propose-serialize` in
[resolve-conflicts](skills/resolve-conflicts/README.md#where-past-merges-conflicted)),
and a person adds the line.

**The outcome log.** Every launch record that ends gets one row in the
[outcome log](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), a
table of the state database written in the same transaction as the
record's end, which never expires: the stage, the repository, the item or pull request, the account,
the model, the duration, a drive's rounds, and an outcome class from a
closed list, with a reason that carries the stage's own answer (the exit,
the recorded result, or the last state):

| Class | What ended there |
| --- | --- |
| converged | a drive's convergence, `CONVERGED` (`0`); a pickup's or follow-up's result `done` |
| merged | a drive whose pull request merged while it ran, `PR_NOT_OPEN` (`5`) |
| quota wall | a usage limit, `QUOTA_PARKED` (`16`), or a session that ended with no result while its wall stood |
| parked for a person | a park, `HITL_PARKED` (`8`); a follow-up pass that stopped on a question |
| stalled | the drive's stall, `STALLED` (`14`), or its round limit, `MAX_ROUNDS` (`6`); a driver replaced by a takeover |
| died | a process gone without an exit; a session that ended with no result |
| refused | a stage's own refusal or a stop it was given: `UNSUPPORTED_CLI` (`2`), `NOT_SETTLED` (`4`), `SINGLE_INSTANCE_LOCK` (`11`), `DRIVE_HELD_BY_OTHER_WORKTREE` (`13`), `MAILBOX_STOPPED` (`18`), `MAILBOX_PAUSE_TIMEOUT` (`19`), `TAKEN_OVER` (`20`), and `PR_NOT_OPEN` on a closed pull request |
| gates failed | a stage that ran to its end without achieving it: `INDETERMINATE` (`1`), `REVIEWER_FAILED` (`7`), `REVIEW_SKIPPED` (`22`), `PR_CONFLICTING` (`9`), `WORKTREE_UNCLEAN` (`12`), `PASS_DEADLINE` (`15`), `CI_REPAIR_SPENT` (`21`), `CI_INFRA_PERSISTED` (`23`); a result `failed` |
| double claim | an item more than one session joins to (an event row) |
| unknown | anything else, with its last state |

What the tick observes rather than what ends is an event row, once per
cause: a stalled pickup, a double claim, a stage drifting from its
expectation, a session waiting, a stop it notified on a drive it did not
launch, each nudge with whether it arrived, and a
[defect](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) that
stopped one stage of a repository's `--apply` (event `defect`, with no
class), which stops that stage only: the repository's other stages launch
in the same tick, the receipt lists it under the repository's
`stageDefects`, and its stack goes to the tick's error output. On the host
that owns the repository, each park that leaves its drive ledger is an
event row too, read from the
[resolution receipt](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
the re-arm left beside it, never from the park's disappearance alone:
`park-answered` with the class, the form of the answers (`approve`,
`choose` or `free`), whether the option chosen was the recommended one,
whether a note narrowed it and how long the park waited for its answer;
`park-provisional` for a park handed on to be decided provisionally; and
`park-removed` for a park the line held that left with no receipt
(withdrawn or framed again on an open pull request). When a pull request
that held parks leaves the open listing, the owner host reads its final
ledger once and counts the receipts it supports under the same occurrence
keys. A failed read leaves its parks held for a later tick; a successful
read retires them. A park with no final receipt stays uncounted, including
when the ledger cut receipts. A park
raised and answered between two ticks is counted from its receipt, and no
park is counted twice. A stop the classifier cannot
place is logged as `unknown`, never dropped, so a reason that recurs among
those rows is what a new class is made from.

**The log as text.** The log prints as text, one line a row, or with
`--jsonl` as JSON lines:

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch log [--since <date>] [--jsonl] [--acceptance]
```

With `--acceptance` it prints, instead of the rows, one line per repository
and decision class over the parked decisions the log counted: how many
parks, how many were answered, how many of those chose the recommended
option with no note, and the median wait for an answer (`--jsonl` prints one
JSON object per line). It counts parks that have left their ledger, so a
park still waiting is not in it, and `--since` selects by when the log
recorded the park's end, not when it was parked: the resolution time for a
park answered or handed on, the time a tick noticed the park was withdrawn
for one removed. It is evidence for deciding whether a class should
stay a park, and nothing acts on it.

Every run also adds the rows it wrote to a copy, one file per month,
`~/.local/state/jig/dispatch/log-<year>-<month>.jsonl`, which never
expires: the archive that outlives any change to the database, kept
current with nobody running anything.

**Expectations and drift.** Each stage the dispatcher launched carries an
expectation while it runs: a drive's unresolved review threads fall (the
tick records the count on the launch record at each ledger round it sees,
and the drive drifts when the latest is not below the count
`dispatch.drive_rounds_flat` recorded rounds earlier); a pickup opens a
pull request within `dispatch.pickup_within`; a follow-up ends within
`dispatch.followup_within`. A stage outside its expectation is reported as
drifting with the evidence (the counts per round, the time since launch,
the item's state), and, where the machine file enables `notify` and the run
applies, notified once, which writes it to the log: a run that only reports
leaves no row for it. It is never acted on: the stage keeps running and keeps its slot, and whether to stop it is a
person's call.

**The one nudge** (the `steer` stage). When an interactive session the
dispatcher launched meets its account's usage limit, the tick reads the
wall from that session's own record (the launch passes Claude Code the
session id it minted) and keeps it on the launch record and as the
account's wall. Once the wall has reset, and the runtime reports the session
waiting with the wall still its last record, the tick types the one nudge
in the closed set, `Your usage limit has reset. Continue` (what a person
types by hand), once per wall: in the same call, the runtime re-reads the
agent's state, that no person has the workspace open, and the screen, which
must show the agent's empty input line and no menu or question; any check
that fails sends nothing. A session still waiting after its nudge, or a
nudge not known to have arrived, is notified, never nudged again. No other
nudge exists: every other stuck state is a notification. With Orca, the
nudge goes to the terminal whose tab and pane make the agent's id, through
`orca terminal read --screen` and `orca terminal send --enter`; since Orca
starts no interactive session yet, there is nothing to nudge until it does.

**The dashboard.** One page that answers, one view each, what is ready to
merge, what needs a person, what is running on which account, what is coming
and how it went, served while the command runs:

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch dashboard [--port <n>]
```

It listens on the machine file's `dashboard.listen`, an address in the
private or loopback ranges (a Tailscale address of the host, say), and
prints a URL whose token every request needs. The foreground command runs
until Ctrl-C. On Linux, the dashboard can also run under its own retry timer,
independent of the dispatch and change-probe timers, without Orca:

```sh
jig dispatch dashboard --install         # preview, using dashboard.listen
jig dispatch dashboard --install --yes   # install once; repeating is safe
jig dispatch dashboard --status          # timer, listener health and log locations
jig dispatch dashboard --access          # print the address to open: the front's, else the private URL
jig dispatch dashboard --uninstall --yes # remove this reader and its retry timer
```

Use the installed plugin's `jig` command. An installed reader needs a fixed
port; stop a foreground reader on that address before installing. Existing
`dashboard.listen`, `require_token` and `allowed_hosts` settings apply to both
forms. The URL is a credential when tokens are enabled: only `--access`
prints the installed reader's URL; service output and installation previews
never print it. The access record is owner-only and invalidated on renewal.
The server routes still only read the dispatch records; availability state
and the private access record live under `~/.local/state/jig/dispatch/dashboard/`.

With a private-network front named as `dashboard.front`, `--access` prints
that front's token-free HTTPS address instead, and on a terminal draws a
[QR code](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (a
square barcode a phone camera reads) of the same address below it, black on
white in colors it sets itself (in plain characters under `NO_COLOR`). The
code holds only the address: the front still signs the viewer in. Into a
pipe, a file, a `TERM=dumb` terminal or one too narrow for the code it
prints the address alone. Without a front,
`--access` prints the private URL as before, draws no code for it, since it
carries a token, and says on standard error how to set up a front.

The supported durable setup is Linux with either a systemd user timer and
**[lingering](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) enabled** (the account's service manager runs without a login), or cron. With systemd, install refuses until
`loginctl show-user <user> --property=Linger --value` answers `yes`; ask the
host administrator to enable lingering for the intended account. Jig does
not change that host setting. A cron daemon must run at boot. macOS
LaunchAgents tied to a login stop at logout, so this install refuses them; use the foreground
command there. Scheduled jobs are unavailable on Windows. Orca is optional
for all dashboard commands.

The timer starts a reader after install, reboot or failure: allow up to two
minutes on systemd (including its default timer accuracy window), or a minute
on cron, plus the installed-copy lookup time. systemd waits a minute after the reader
exits before retrying; cron checks every minute and the reader lease excludes
overlaps. A reader notices a new installed plugin copy within a minute and
exits so the next invocation starts that copy. It stops on the next one-second poll
when its configuration changes or disappears (after any in-flight bounded
installed-copy lookup), and renews at the launcher's
24-hour deadline even without an update. Transient registry failures keep the
current reader serving and retry the lookup. Each renewal rotates the token;
run `--access` again for the new URL. The command does not install a private
network front or open a public listener. To open the page from a phone over
private HTTPS, or over private HTTP with its limits, follow
[phone-access.md](phone-access.md).

To verify availability on the configured host, first wait for `--status` to
report a healthy reader and note its pid. End the terminal session, reconnect
and repeat `--status`; after a host reboot, repeat it again. For crash recovery,
systemd users can run `systemctl --user kill --signal=SIGKILL
jig-dispatch-dashboard.service` and wait for the next healthy status with a
new pid. After updating the installed plugin, check the same recovery and
obtain a new URL with `--access`. A stopped or disabled timer, failed copy
lookup, occupied listen address or missing configuration is diagnosed by
`--status` and the log locations it prints. These checks distinguish host
logout and reboot verification from the automated process and scheduler tests.

The page reads two things, every minute and when it comes back into focus, and
writes nothing to the host:

- **What the newest tick found**, one question to a view, each tab with its
  count: **Merge**, the converged pull requests in Ready to merge's lanes
  (merge now, approve first, update next), each merge now card with its
  merge command pinned to the verified head; **Needs you**, the parks, stops
  and stalled pickups waiting on a person, with the question and the
  recommendation in place, what any stale or disputed answer that keeps a
  decision waiting chose, and the whole decision one tap away; **Running**,
  each account's slots and the sessions in them, with their evidence; and
  **Queue**, what comes next and why. The page opens on Merge while merge now
  holds a pull request, else on Needs you, and while it holds one every other
  view says so at its top until dismissed, which lasts until a pull request
  reaches merge now at a new head. Each tick
  writes it to the state database beside its receipt (the `tick_line`
  record): a repository's part (its needs, queue, sessions and Ready cards)
  comes from the newest tick that read it, and the rest from the newest tick
  the timer asked for every repository the machine file lists, even when
  another tick held some of them busy; the one exception is the duration
  history (`longestTickMs`, `recentTicksMs`), to which a woken tick adds its
  own duration. So the strip says how old that tick
  is, a stopped timer shows as one while wake-ups for one repository still
  run, a repository no tick has read for longer than the timer's interval
  and its longest recent tick gets a banner naming it, since when and why (another tick held it busy),
  and a host may serve the page from a copy of that database, with no other
  read. Every card and log row shows its item's title beside its key and
  links the key: to the link the tracker gave, or, for a row that kept none,
  to one worked out from another item link of the same repository's tracker.
- **How the recent ticks ran**, at the top of the History view: one row per
  tick, the newest first, with its length, its phases as a bar, the slowest
  single phase and its repository, the forge's rate budget it read, and a
  chip for a defect or a failed exit; each row opens to every phase and
  repository. Low-budget and busy-repository chips require a tick producer
  that records those signals; the current producer does not. The line carries
  the last 48 ticks, a tick for
  one repository included.
- **The outcome log**, on the History view, filtered by time (today, yesterday,
  seven or thirty days, or a range), repository, stage, account, class and
  reason, counting each class over the window and naming each recurring
  class: a bad class (any but converged, merged and parked for a person) of
  one stage on one repository on at least three of the last seven host days,
  counting the ended rows and the event rows that carry a class, such as a
  drive stopped for a person (a drift carries none). A question about
  yesterday is the Yesterday filter, and the view and the filter are the
  page's address, so a view on a phone is a link a laptop opens.

Keys reach every card: j and k move between the cards, Enter or o opens
one, p and i open its pull request or issue, c copies its command (the merge
command, a parked need's answers or its `jig ask` line), g then m, n, r, q or
h goes to a view, / filters, ? lists the keys, and ⌘K or Ctrl-K opens a
palette that goes to a view, jumps to `#N` or an item, or copies a card's
command. On a parked need, 1 to 9 pick an option of the current decision (1
is always the recommended one) and move to the next decision with no pick,
h and l move between its decisions, u clears the last pick, r writes a note
beside a pick or an answer in the person's own words, and Escape leaves that
field. No key fires while a person types in a field.

The Help view lists the keys and says what the page's words, stages and marks mean; a chip, a
dotted word or the `?` beside a heading says it in place, on hover, tap or
focus. The theme follows the device until the switch in the strip picks light
or dark.

The page acts on nothing: it links to the pull request a decision is answered on
and copies what cannot open, such as a workspace path or an answer line. A
parked need shows one short row per decision, and a person picks an option
with a key or a tap, adds a note or writes an answer in their own words; all
of it stays in that browser only, can be undone, and is dropped, with the row
saying so, when the decision is framed or parked again. The card's Copy takes
one comment answering every decision picked, `answer <key>: approve [<digest>]`
or `choose <option>` with the framing's digest and any `note <key>:` line,
ready to paste on the pull request; with nothing picked, a card of one
decision under a class listed as Decide copies its approval when its recommended option can be undone and no earlier answer was dropped, and otherwise only the starting `answer <key>:` line. A pick under a
class not listed as Decide, or of an option that cannot be undone, copies only
on the second step, which first shows what it changes and costs. When the
server stops answering, it keeps what it last read and says when that was.

**The line as JSON.** A program beside the dispatcher (an editor's plugin, a
status bar) reads what the newest tick found without opening the state
database:

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts dispatch line --json
```

It prints one JSON document, the answer the dashboard's `GET /state` gives
for the same database, from the same read:
`{"ok":true,"value":{"now":…,"timeZone":…,"plugin":…,"schema":…,"line":…}}`.
That answer is the contract: `line` is the tick's snapshot
(`LineSnapshot` in `dispatch/lib/dashboard-contract.ts`), versioned by its own
`version` field, which a reader checks before it trusts the rest. The command
takes no lock, so it runs while a tick does, and never creates the database.
Each entry in `line.needs` carries `workspace`, the path holding that drive,
pickup or follow-up, from the tick's launch records or the runtime's joined
workspaces. It is `null` when none is known or the records are ambiguous.
It never falls back to the notices workspace: `notified.workspace` still
names where the notification went. This is an additive version-1 field;
readers treat its absence in an older snapshot as unknown.
Each entry in `line.repos` carries `tracker`, the adapter its configuration
names (`{"adapter":"linear"}`), and each row of `needs`, `sessions`, `queue`
and `ready` carries `links`: for a pull request, the items its branch names,
its description closes (`Closes`, `Fixes`, `Resolves`) or the forge says it
closes; for an item, the open pull requests that do. Both are additive
version-1 fields too, read from the tick's one query of the repository's
open pull requests with no request of their own. A row has no `links` when
the tick could not tell, such as when that query did not read in full or
the pull request is no longer open, so an empty list means none.
Its exit codes:

- `0`: the answer is printed. Its `line` is `null` when no tick has written
  one yet, the database not existing included.
- `1`: the stored line cannot be read (it is not JSON, is in a form this
  plugin does not read, or the database is a newer plugin's that requires a
  newer reader). Nothing is
  printed on standard output, and one line on standard error names the code,
  `line-unreadable`, and the reason. The next tick writes a line this plugin
  reads; a newer plugin's database that requires a newer reader needs this plugin
  updated first; one a reader at this version can still read is read.
- `2`: the command line was refused.

**When a class recurs.** The tick tunes none of its own dials. A class that
recurs (the dashboard's definition above) is a finding about the
scaffolding. Where reflection is on for the repository (a
[`reflection` section](CONFIGURATION.md#reflection) in any configuration
layer, the repository's own read from its default branch), a tick with
`--apply` on the host that owns the repository records it, after its
launches, as one finding per week in the reflection store: an error about
the dispatcher as a Jig tool, its class `dispatch-recurring-<class>` (such
as `dispatch-recurring-gates-failed`), with the repository, the stage, the
days, the row count, the reasons the rows give most often and the
dashboard filter that shows them. A later tick that week records nothing
new; a class still recurring the next week is a new occurrence, so the
default escalation, at three occurrences of a class, is reached after three
weeks of one recurrence, sooner when several repositories or stages
record the class in the same week. A store that fails or
does not answer within `reflection.timeout_sec` is named on the receipt
and tried again by the next tick, and the tick's exit status stays as it
was; a tick without `--apply` lists what it would record. The tick never
acts on a recurrence: [`review-reflections`](skills/review-reflections/README.md),
run in Jig by a person, is where the change is approved, a cap, an
expectation, a skill's step, or where the finding is moved to the
repository's own scaffolding. A pattern the route does not count (pickups
that drift past `pickup_within`, since a drift carries no class; quota walls
at the same hour; a reason recurring among the `unknown` rows), and any
recurrence while reflection is off, is a person's to record with
[`reflect`](skills/reflect/README.md).

**The morning routine.** Nothing needs restarting after a night: the timer
ran every tick. Read the morning report,
`drives.ts --report` ([drive-pr](skills/drive-pr/README.md)), which lists
beside the drives what the dispatcher launched, refused and notified on this
machine since the last report. Answer each park from the phone: open the
unread workspace, read the framed decision, and comment `answer <key>: …` on
the pull request; the next tick re-arms the drive. Settle what a
notification says only a person can (a failed follow-up's marker, a stalled
pickup, a stop with its handoff, a drifting stage), then merge what
converged: the dispatcher never merges. To see how the night went, open the
dashboard on Yesterday.

**`jig install dispatch`** previews the timer that runs `--apply` every
interval (the machine file's `interval`, five minutes by default), and
writes it with `--yes`, from the installed plugin copy, on the scheduler
code [resource collection](gc/README.md) uses: a systemd user timer, a
launchd job or a crontab line; `jig install` with no component named
installs it too once the machine file exists. Install it on the host that
runs the sessions (with Orca, the Orca server's host).
`jig uninstall dispatch --machine --yes` removes it. Beside it, the same
install writes the [change probe](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)'s
timer, which runs `jig dispatch probe --apply` every minute: one search on
the forge over every repository the machine file dispatches (each with a
stage enabled) for the pull requests updated since the last probe (a
review, a comment, a label, a push, a merge or a close) and every open
one's checks, which wakes the tick of each repository where something
changed, under the rule `jig send`'s wakes follow (below), and of no other.
A minute with no change starts no tick. On GitHub that search is one
GraphQL call for a single page of results (measured at 1 point of the 5,000
an hour; further pages add calls and points), apart from the REST limit, made
from outside every checkout, so the account `gh` uses there must see every
repository: one it cannot see is named in each probe's output, and its
changes wait for the sweep. A probe that cannot read the forge wakes
nothing, says why and exits `1`; the sweep runs on its own timer either way.
Only one applying probe runs at a time: one that finds another running does
nothing. A probe whose wake or state write failed prints why and exits `3`.
The probe wakes the repositories together and waits for their ticks before it exits, since a scheduler
ends what a job leaves running, and the wake's log
(`~/.local/state/jig/dispatch/wake/<digest>/last-run.log`) names the probe as
who asked. `jig dispatch probe`, without `--apply`, says what it would wake
and writes nothing. `change_probe: false` in the machine file turns it off:
a probe run then reads nothing, and the next install removes its timer.
`jig upgrade` refreshes the probe's timer with the tick's; a machine whose
dispatcher timer was installed before the probe existed gets the probe's at
its next `jig install dispatch --yes`. `jig install dispatch
--repo <path>` also lists the [state labels](#the-dispatcher) that
repository turns on and lacks, and creates them with `--yes`, as
`jig dispatch labels` does with no job installed. The earlier
`jig dispatch install [--interval 5m] [--yes] [--uninstall]` keeps working,
and is the one form that sets an interval other than the machine file's.

The session runtime it reads and launches in is
[Orca](https://www.onorca.dev) (`ORCA_CLI_COMMAND`, else the command in
`ORCA_CLI_BIN_DIR`, else `orca-ide` on `PATH` on Linux and `orca` elsewhere,
the names Orca installs its command under; on Linux a bare `orca` is often
GNOME's screen reader),
behind an interface a second runtime can be added to. A timer's environment
holds none of a login shell's, so the install writes the two variables, as
the shell that runs it sets them, into both the tick's job and the probe's.
The repository's
values are its [`dispatch` section](CONFIGURATION.md#dispatch), read from
its default branch on the forge.

## Asking a station where it stands

`jig ask` answers, from the records alone, who holds one station of the
execution line on one piece of work, what state it is in, what it waits on
and how its last launch ended. It writes no record, starts no session and
changes nothing on the forge or the tracker
([ADR-0014](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0014-addresses-are-derived-and-requests-are-records.md)):

```sh
jig ask <station>@<owner>/<name>#<key> [--json] [--thread [--since <date> | --all]]
jig ask --waiting [--person <login>] [--json]
```

In a session, [`/jig:operator`](skills/operator/SKILL.md) runs `jig ask`
and `jig send` for you: ask it "where does 456 stand" or "what is waiting on
me", or tell it "hold 456". A status comes back as the same card every
time: `jig ask`'s own answer, then four lines saying where the work stands,
what it waits on, what you can do and what was not read. `/jig:operator
456` asks that of pull request 456, or of issue 456 when no pull request
has that number, and `/jig:operator` on its own lists what waits on a
person, one line per entry. Anything else it answers in sentences.

**The address.** A station on a piece of work has an
[address](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
`station@owner/name#key`, such as `drive@jig-harness/jig#456`:

| Station | Key | Who holds it |
| --- | --- | --- |
| `pickup` | the tracker's item key (`#12` on GitHub Issues, `ENG-4` on Linear or Jira) | the session that claimed the item |
| `drive` | the pull request's number | the live driver: a dispatched re-arm or takeover, or a driver someone armed by hand |
| `followup` | the merged pull request's number | the follow-up pass, or a person's run |

The repository may be its short name where the
[machine's dispatch file](CONFIGURATION.md#the-machines-dispatch-file) lists
exactly one repository of that name (`drive@jig#456`), or left out inside a
checkout of it (`drive#456`). Some shells give `#` a meaning of their own, so
the key may also follow as a second argument: `jig ask drive@jig 456`. The
key is checked against its tracker's or forge's form before anything is
read; a pick-up's key needs a checkout of the repository on this machine,
whose configuration names the tracker.

**The answer.** Every answer prints the address in full and these fields:

| Field | What it says |
| --- | --- |
| `holder` | the launch that holds the station now: its stage, its host (`this machine`, or another dispatching host as its launch claims name it), the drive's driver generation, and whether its process is alive, dead or unknown; the account, the session and the launch record where this machine's records name them; `none` when nobody holds it |
| `state` | the station's state in its own words: for a drive, `running`, the [terminal-state](skills/drive-pr/README.md) name of its last stop (`HITL_PARKED`, `CONVERGED`, …), `not driven`, `merged` or `closed`; for a pick-up, `assigned`, `claimed`, `stalled`, `doubly claimed`, `not assigned` or `closed`; for a follow-up, `claimed`, `done`, `failed`, `not claimed` or `not merged` |
| `waitsOn` | `none`; `waiting`, with what it waits for, when it settles by itself (a dispatcher's next tick, another driver); or `person`, with the act that settles it: answer, re-arm, merge, re-run the follow-up, choose the session that keeps the item, look at the stalled pickup, settle a pickup's question and return the item to the dispatch states, answer the waiting session, or assign the item as someone who can write; and `needAct`, what the person does as the dispatch dashboard groups it (Merge, Decide, Authorize, Reply, Do or Investigate; a park's comes from its decision class) |
| `last` | the last ended launch: its class from the [outcome log](#the-dispatcher)'s closed list and when, from this machine's outcome log or, elsewhere, from the end written on its launch claim |
| `sources` | every record kind the answer consulted, whether it was read and why not, and how many forge and tracker calls it made |

**What it reads.** A `drive` or a `followup` reads the pull request and its
comments once (the drive ledger, the launch claims, the follow-up marker,
the merge-ready announcements and the answers all come from that one read)
through the conditional requests the drive uses, so a pull request that has
not changed since the last read costs nothing against the forge's limit; it
never calls the tracker. A `pickup` reads the item through the tracker the
repository's configuration names, and makes no forge call. On the machine
that dispatched the work it also reads the dispatcher's launch records, its
outcome log and, for a drive, the drive's own listing in a checkout of the
repository (`drives-read-only.ts`), whose doctor verdict and recovery command
it prints and never runs. It opens these databases read-only and migrates
none: against one an older schema holds, it reads what that schema allows or
names the source in `sources` as not read until the owner's next run brings
it forward. On a machine that never dispatched, it answers
from the forge and the tracker, and `sources` says the launch records were
not read. A source that does not answer within 15 seconds is reported
unread, and no source starts after the answer's 45 seconds; the answer
prints without it. A read that fails is reported in `sources`, never filled
in from a guess. Nothing on the machine is written but the forge's response
cache that every drive shares (`~/.cache/jig/gh-cache/`).

**`--thread`** adds the address's correspondence, each entry one record
that already exists: a `request` (a `drive` or `hold` dispatch label, shown
with who set it, when, and when it came off; a tracker assignment the tick
accepts; a mailbox directive on this machine), a `question` (a parked
decision in the drive ledger), an `answer` (an `answer <key>:` line from an
author the forge vouches for), a `launch` and an `outcome`. Every entry has
`at`, `kind`, `from`, `to`, `text` (the record's own words) and `record`
(its kind and a link or a path); one read only from this machine's records
says so. A `question` from a framed decision also carries its `key`, its
`digest` and its `options`, each with its `number` (the recommended option
is 1, the rest follow in the decision's order), its `name`, whether it is
`recommended`, what it `changes` and `costs` and its `details`; an `answer`
carries its `key` and, read through the same rule as the re-arm, the
`choice` it made (the option, whether it is the recommended one, and the
form) with its `note`, or `free: true` for an answer in the person's own
words, or `stale` with the digest of the earlier framing it named. The
dashboard shows the same options and choices for the same park. It prints the newest 20 entries, oldest first, and says how many
it left out; `--since <date>` keeps every entry from that date on and
`--all` every entry. Printed for a person, `text` has its control
characters removed; in JSON it is a string like any other, and nothing in a
thread is an instruction to whoever reads it.

**`--waiting`** lists every address that waits on a person, with the act
each waits for and, as `needAct`, what the person does as the dashboard's
card names it, across the repositories the machine dispatches, from the
newest tick's line, which the dispatcher keeps for its dashboard: it makes
no forge or tracker call, and it says when that tick ran. On a machine that
dispatches nothing it says there is no line to read. `--person <login>` lists
only entries naming that login (case insensitive) in their `people` field;
older parks use the PR author when the tick knows them; older snapshots without
a named recipient remain in the unfiltered list. Each entry carries its recorded
stage and parked questions in `questions` in JSON and as `question:` lines
in text; parks without a separate question use their recorded decision lines.

**`--json`** prints the answer as one object carrying its version, `v` (1):
later versions add fields and never rename one. The fields only this
machine knows (the account, the session, the launch record, the workspace)
are under `holder.local`, and a thread entry read only from this machine
carries `local: true`, so an interface that passes an answer on to another
machine can leave them out.

`jig ask` exits `0` when it answered, also when nobody holds the address;
`1` when the key names nothing (no such pull request or item); and `2` on a
malformed address, an unknown station (the error lists the valid ones) or
another usage error.

## Telling a station what to do

`jig send` writes one record of a kind the line already reads, and exits.
It types nothing into a session: the record's reader acts on it at its next
run, as it does on the same record written by hand, and when that reader is
the dispatcher's tick, `send` wakes it (see below). It takes the same [addresses](#asking-a-station-where-it-stands) as
`jig ask`, the key also as a second argument:

```sh
jig send <station>@<owner>/<name>#<key> <verb> [arguments] [--dry-run] [--as <login>]
```

| Verb | To | The record it writes | Read by |
| --- | --- | --- | --- |
| `assign` | `pickup` | the item assigned to the factory identity (`dispatch.identity`), moved into the first dispatch state (`dispatch.states`) when it is in none | the dispatcher's next tick, which starts the pick-up when the person who made the assignment can write to the repository |
| `drive` | `drive` | the `drive` [dispatch label](CONFIGURATION.md#dispatch) | the dispatcher's next tick, which arms a drive |
| `rearm` | `drive` | the `rearm` dispatch label for a stopped drive | the dispatcher's next tick, which re-arms it on an admitted account in the existing worktree |
| `hold`, `release` | `drive`, `followup` | the `hold` dispatch label, added or removed | the dispatcher's next tick, which keeps every stage off a held pull request |
| `answer <key> <text>`, `answer <key> --approve`, `answer <key> --choose <option>`, `answer --all --approve` | `drive` | a comment on the pull request whose first line is `answer <key>: <text>`, or `answer <key>: approve [<digest>]` and `answer <key>: choose <option> [<digest>]` for a structured answer, one comment per item for `--all` | the re-arm, which hands the answer to the drive's passes as your verdict |
| `answer <key> --approve`, `answer <key> --choose <option>` | `followup`, `pickup`, `drive` | for a need's decision other than a park's (a follow-up's, a pickup's, or the dispatcher's own framing), the same structured comment on the pull request, or on the item where the items are the forge's issues | the dispatcher's next tick on the host that owns the repository, which carries out the option once (see [Every need is a decision](#every-need-is-a-decision)) |
| `pause`, `resume <hold-push\|pause\|stop>`, `stop`, `hold-push` | `drive` | a directive in the [mailbox](skills/drive-pr/README.md) of the working tree that holds the drive on this machine | the driver: `hold-push` before each push, `pause` and `stop` at its next round boundary |

**It checks before it writes.** It reads the address first, through `jig
ask`'s readers, and refuses (exit `1`) a request the station cannot take:

- `assign` on an item already assigned to anyone, claimed, in progress or
  closed, or in a repository that names no factory identity;
- `drive` on a pull request that is not open, already has a drive ledger, or
  already carries the label; a second `hold`; a `release` with no `hold`;
- `rearm` without a stopped ledger or an existing worktree on this machine,
  while a driver or launch still holds it, after a person's recorded stop,
  or while a re-arm request is already pending;
- `answer` whose key is not a parked question in the pull request's drive
  ledger, or when not every place an answer could be (the pull request's
  comments, a parked thread's replies) was read; a structured answer
  naming an option the park does not offer, `--approve` on a park with no
  recommendation, and one whose digest is no longer the park's (below);
  to a need's decision, an answer whose key no need of the address carries
  in this machine's newest line, your own words (the tick carries out an
  option), and an item on a tracker other than the forge;
- a mailbox directive already in force, a `resume` with nothing to withdraw,
  a drive no driver on this machine holds, and a drive another host holds,
  which it names: a directive reaches a driver on this machine only, so
  stopping a drive elsewhere stays that host's act.

The text of an `answer` is one line of at most 500 characters, with no
control character (no line break, no mark that reorders text) and no hidden
marker (`<!--`), since it reaches the drive's passes as your verdict; any
other text is a usage error (exit `2`). Several words after the key are
joined with a space.

**Structured answers.** `answer <key> --approve` chooses the option the
parked decision recommends, and `answer <key> --choose '<option>'` the
option of that name, matched as the drive's readers match it (case,
typographic quotes and a final full stop do not matter) and written as the
park spells it. `--note '<text>'` adds a `note <key>:` line beside either,
checked as an answer's text is. An answer names exactly one of your words,
`--approve` or `--choose`; one that names none, or two, is a usage error.
Your words are refused on a framed park when the drive's readers would
count them as a choice (`approve`, `choose Keep`): send that as `--approve`
or `--choose`, which binds it to the framing you read.
A framed park carries a
[decision digest](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
run the send with `--dry-run` first, which shows the option in full (what it
changes and what it costs) with the digest, and prints the command to send,
naming the digest with `--decision <digest>` (and repeating any `--as`). A real structured send must
name it, and is refused, writing nothing, when the park's digest is another
(the drive framed the question again since you read it). A park from before
digests has none: its answer is bound by time alone, and `--decision` is
refused there. The comment carries the digest and the choice in its record
too.

**Answering again.** Each person's latest answer is the one the drive
counts, so you may answer an item you already answered: `send` shows your
earlier answer first and says the new one replaces it. Another person's
answer does not stop a send; `send` names it, and when your answers differ
(another option, another note, or a free answer beside a structured one)
the item is disputed and waits until you agree. Another person's stale
answer (one naming an earlier framing) keeps the item waiting until they
answer again.

**Approving several at once.** `answer --all --approve` approves the
recommendation of every open item (none answered or disputed) whose class
Jig's table of acts lists as Decide by name, one comment per item. It
leaves out, saying why, a class whose act is another (Authorize, Merge,
Reply), a repository's own class (which the table does not list), an item
another person answered (stale or not), an item with no framed decision or
recommendation, and a park from before digests; each of those is approved
only by its own key. Its `--dry-run` lists each item it would approve with
its digest and prints one
[decision set token](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md);
the real send names it (`--decision-set <token>`) and is refused, writing
nothing, when the items or any digest changed since. When the forge refuses
a post part-way, `send` prints the comments it posted, wakes their reader,
names the items it did not send and exits `1`; run the dry run again for
the rest.

**It says who writes, and where.** Before it writes it prints the
repository in full, the login it writes as (the forge login the `gh` client
here is signed in as, or for `assign` the user the tracker's credential acts
as), the record, where it goes, the reader that acts on it and how to take
it back. `--as <login>` refuses when this machine writes as anyone else. An
`answer` is a comment readable by whoever can read the pull request, and
`send` says so; the comment carries the
[record envelope](RECORDS.md#the-registry-and-the-envelope) in a hidden
marker, naming you and this host as a digest. `send` adds no authority:
each reader keeps its own rule for whose record counts, an assignment made
by someone who can write to the repository, an answer from an owner, member
or collaborator.

**What it refuses outright.** A verb whose record the repository has
switched off is refused with the setting named: `drive`, `rearm`, `hold` and
`release` need `dispatch.labels.enabled`, read as the dispatcher reads it,
from the configuration on the repository's default branch, and the label
carries the repository's prefix. A machine whose
[dispatch file](CONFIGURATION.md#the-machines-dispatch-file) says
`send: false` refuses every send. A session the line started (a dispatched
launch, or a drive's pass) runs with `JIG_LAUNCH` set, and there `send`
refuses `assign`, `drive`, `rearm`, `hold`, `release` and `answer`, which are a
person's commands; the mailbox verbs are not refused by it. That stops a
skill's mistake; a session holding its person's credentials could still
clear the variable or call the forge itself, as it could before.

**The mailbox verbs.** The working tree, its mailbox and the driver
generation come from the drive's own listing in a checkout of the
repository here (`drives-read-only.ts`). A `stop` is addressed to that
generation, so it ends that driver at its next round boundary and a later
driver ignores it (`drives.ts --stop` also cancels the running pass at
once). The mailbox lets only a `stop` name a generation, so a `pause` or a
`hold-push` holds every driver of the pull request in that tree until
`resume pause` or `resume hold-push` withdraws it; `send` names the
generation that holds the drive when it is sent. A `resume` needs only the
tree, so it also clears a directive a driver left behind.

**It wakes the tick that reads its record.** After `assign`, `drive`, `rearm`,
`hold`, `release` or `answer`, when this machine's
[dispatch file](CONFIGURATION.md#the-machines-dispatch-file) lists the
repository with the stage the tick acts under (`pickup` for `assign`,
`followup` for a follow-up's `hold` and `release`, `rearm` for the rest),
`send` wakes that repository's tick: a [waiter](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) in the background runs `jig
dispatch --apply --repo <path>` the way the installed timer does, when idle
and no sooner than a minute after the last tick it started, rather than
at the next timer run. The change probe (above) wakes ticks under the same
rule: requests pending before a tick starts are taken by that one tick, and
a request made after it started is taken by one trailing tick. Several sends
pending together start one tick. A tick that
finds another tick reading that repository, or acting for longer than it
waits, is tried again a minute later; the
waiter exits when nothing is pending, or after starting 10 ticks; the record stays the request, so the
next timer run reads it whatever happens to the wake. What the waiter did
is in `~/.local/state/jig/dispatch/wake/<digest>/last-run.log`. A mailbox
directive wakes nothing: the driver reads it at its next round.

**`--dry-run`** prints all of that and writes nothing. A real send ends
with the link to what it wrote (the pull request, the comment, the item) or
the mailbox's path, and the reader that acts on it next: the dispatcher's
tick for the repository, woken now or to start when idle and at least a minute after the last start,
when the send woke it. The forge can take
a moment to list a new comment, so that link, not a `jig ask` right after
it, shows the request landed.

**What can be taken back.** `release` undoes a `hold`, and `hold` a
`release`; a `drive` or `rearm` label can be removed by hand until the tick has armed
the drive; `resume` withdraws a directive; an assignment can be undone on
the tracker until the tick starts the pick-up. An `answer` the re-arm has
read cannot be taken back, which is why it is checked, shown and sent in
your own words; until then, deleting the comment withdraws it.

A drive stopped with `WORKTREE_UNCLEAN` (exit `12`) gets one automatic
recovery pass per pull-request head, in the tree holding its branch. That
pass is told to commit and push edits belonging to the change, or discard
them when they do not belong. A second exit `12` at that head waits for a
person; after inspecting the handoff, request another attempt with
`jig send drive@<owner>/<name>#<PR> rearm`. A missing tree waits for a
person too: recovery never opens a replacement tree without the edits.

`jig send` exits `0` when it sent (or, with `--dry-run`, would send), `1`
when it refused or the write failed, and `2` on a usage error: a malformed
address, an unknown station or verb, a verb the station does not take (the
error lists the verbs it takes), or an answer's text that is not one line
within its limit.

## Set up from an agent session

An agent can do the setup with you: check what is installed, tell you the
one step it cannot take, and run the first audit. Installing is the step it
leaves to you: the plugin changes every repository on the machine, and a
session loads a plugin only when it starts, so the session that installs it
could not use it anyway. Paste this into a session of Claude Code or Codex
started in the repository you want to adopt Jig in:

```text
Set up Jig (https://github.com/jig-harness/jig) in this repository, then audit it.

1. If this agent tool has no plugin support, say so, give me these steps
   and stop: clone https://github.com/jig-harness/jig.git; copy or link every
   folder of its plugin/skills/ into this tool's user skill directory (for
   example ~/.claude/skills/ or ~/.agents/skills/), side by side, and its
   plugin/shared/ into a shared/ folder beside that directory; then start a
   new session and run the audit skill, under its bare name.
2. If the jig:audit skill is available in this session, run it and follow
   it; stop here.
3. Otherwise look for jig@jig in `claude plugin list` or
   `codex plugin list`. Act on what it shows:
   - Installed and enabled: this session started before the install. Tell
     me to run /reload-plugins (Claude Code) or start a new session
     (Codex), and stop.
   - Installed but disabled: tell me to enable it, with
     `claude plugin enable jig@jig` (Claude Code) or by setting
     `enabled = true` under `[plugins."jig@jig"]` in
     ~/.codex/config.toml (Codex), then to run /reload-plugins or start a
     new session, and stop.
   - Not listed: go on to step 4.
4. Check the requirements: Bun, git 2.36 or later,
   and the GitHub CLI 2.48 or later, signed in (`gh auth login`) to the
   repositories you work on. Tell me what is missing and how to install it.
5. Then give me the install command for this tool and stop. I run it in a
   terminal and start a new session in this repository, since a plugin
   loads only when a session starts.
   - Claude Code 2.1.292 or later:
     claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#stable
     Older Claude Code: claude plugin marketplace add
     https://github.com/jig-harness/jig.git#stable, then claude plugin install jig@jig
   - Codex:
     codex plugin marketplace add https://github.com/jig-harness/jig.git --ref stable
     codex plugin add jig@jig
```

The prompt carries everything the agent needs, so it fetches nothing. In
the new session, run the audit: `/jig:audit` in Claude Code, or ask for the
`jig:audit` skill in Codex ([use a skill](#use-a-skill)).

## Bootstrap setup

The [bootstrap guide](https://github.com/jig-harness/jig/blob/main/tools/plugin/bootstrap.md) provides shell and
PowerShell entry points from a reviewed source checkout. They preview the
machine and marketplace state, prepare missing prerequisites only with
explicit opt-in, and install through the agent marketplace only with an
explicit apply flag. Authentication stays explicit, and scheduled jobs
remain a separate action. Cross-platform authenticated validation is still
open; the guide lists the evidence it needs.

## Requirements

| Tool | Version | Needed for |
|------|---------|------------|
| **Claude Code** and/or a **Codex CLI** with plugin support | Claude Code 2.1.292 or later for the one-step install below (older: the two-step install), and 2.1.285 or later for a drive's [long background commands](skills/drive-pr/README.md#the-background-time-limit). Codex: tested with 0.159 | Every skill. Either tool is enough; install for each one you use |
| **[Bun](https://bun.sh)** on `PATH` | The version in [mise.toml](https://github.com/jig-harness/jig/blob/main/mise.toml), which Jig tests; an older Bun may lack an API a script uses | Every skill's scripts, which are TypeScript run by Bun. The repository being worked on needs no Bun of its own |
| **git** | 2.36 or later (`--path-format` for absolute paths and `git worktree list -z`; `resolve-conflicts` needs 2.41, to reconstruct automatic merge results and read attributes from the index with `--attr-source`, and its history report 2.43, or 2.45 in a partial clone) | Every skill that reads the repository |
| **GitHub CLI** (`gh`), signed in with access to the repositories you work on | 2.48 or later (`gh api --slurp`) | Every skill that works on pull requests. Jig supports GitHub as its only forge ([extending](EXTENDING.md#forge-github)) |
| **The `gh-stack` extension** | Any | Only `pull_requests.stacking: native` |
| **Issue-tracker access** | — | `do-item`, and `drive-pr`'s tracker reads. With the default GitHub adapter, the signed-in `gh` above and nothing more. With the Linear adapter: `LINEAR_API_KEY` or `LINEAR_API_TOKEN` in the environment, or the Linear MCP server or `linear` command line tool signed in. With the Jira adapter: `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment, an Atlassian account's email address and an API token made for it, or an OAuth access token or an API token with scopes in `JIRA_BEARER_TOKEN`, or a command that prints one in `JIRA_TOKEN_COMMAND` ([environment variables](CONFIGURATION.md#environment-variables)) |

Most skills do not check these versions when they run: an older tool fails
on the command it lacks. The `resolve-conflicts` history report is the
exception: it checks git's version first, and refuses an older git, or a
partial clone on a git that cannot be kept from fetching.

- **macOS, Linux and Windows, including PowerShell.** Skill commands use
  Bun with plain arguments. Shell composition and generated input are handled
  inside scripts; commands that read generated text take a file argument.
  Git Bash is optional for the skills' own commands. A consumer's configured
  setup or check command still needs its own runtime and tools. Native Windows
  tests run in CI, but the complete authenticated
  pickup → draft pull request → drive round → stop smoke test, under Claude
  Code and under Codex with PowerShell, is still pending. See [drive-pr](skills/drive-pr/README.md) and
  [do-item](skills/do-item/README.md) for the current validation limits.

## Install the plugin

**Setup entry points.** The shell and PowerShell [bootstrap](#bootstrap-setup)
is available from a reviewed source checkout; authenticated cross-platform
validation remains open. An own Homebrew tap requires a later maintainer
decision after validation. The
[distribution design](https://github.com/jig-harness/jig/blob/main/design/distribution.md)
records the order and update ownership. The marketplace commands below
remain the direct installation path.

Run these once per machine, in a terminal (not inside an agent session).
They follow the `stable` [release channel](#release-channels), which
receives a version once it has proven itself; put `latest` in place of
`stable` to receive every version as soon as it is released.

**Claude Code** (one step: it registers the marketplace and installs; on
Claude Code older than 2.1.292, run `claude plugin marketplace add <address>`
and then `claude plugin install jig@jig` instead):

```sh
claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#stable
```

**Codex**:

```sh
codex plugin marketplace add https://github.com/jig-harness/jig.git --ref stable
codex plugin add jig@jig
```

**Both at once**, from a checkout of this repository (it installs for each tool
it finds on `PATH`, following `stable` unless `--channel latest` says
otherwise, and updates when already installed). Once
[the `jig` command](#the-jig-command) is on `PATH`, `jig upgrade` does the
same and more:

```sh
bun tools/plugin/setup.ts
bun tools/plugin/setup.ts --channel latest
```

**Check** what is installed: `jig doctor` reports the plugin in each tool
and the channel it follows, beside its other checks, and exits 1 when one
fails. Without the `jig` command, the tools list their plugins:

```sh
claude plugin list        # shows jig@jig, enabled
codex plugin list         # same for Codex
```

Claude Code can also hold the plugin per directory, at project or local
scope (`claude plugin install --scope project`), alongside the user-scope
install above. Where both exist, Claude Code (2.1.311) loads the user-scope
copy, but `claude plugin update jig@jig` without `--scope` updates the most
specific one, so a forgotten project-scope copy falls behind unseen.
`jig doctor` lists each and fails one older than the user-scope install or
left behind by a deleted directory; `jig upgrade` refreshes or removes them.

Start a **new** session afterwards. Sessions that were already open load the
plugin after `/reload-plugins` (Claude Code) or a restart (Codex).

For an organization, an administrator can install it on every machine instead.
Claude Code reads `extraKnownMarketplaces` and `enabledPlugins` from
[managed settings](https://code.claude.com/docs/en/plugins/org); name the
channel as the source's `ref`:

```json
{
  "extraKnownMarketplaces": {
    "jig": {
      "source": {
        "source": "git",
        "url": "https://github.com/jig-harness/jig.git",
        "ref": "stable"
      }
    }
  },
  "enabledPlugins": { "jig@jig": true }
}
```

A Codex workspace administrator can sync a GitHub marketplace for the team;
point it at the `stable` branch where the sync lets you choose one.

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
   This file is the *consumer overlay* (see the [glossary](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)):
   the repository's own values, laid over the shared procedure. JSON is valid
   YAML, so a JSON-formatted file works too. The minimum for
   `resolve-review-comments`:

   ```yaml
   gates:
     command: make check             # the full local checks before a push
   review:                           # optional
     bots: ["example-review[bot]"]   # your AI reviewer's login
     deferral_team: ENG              # issue-tracker team for deferred findings
   ```

   Only `gates.command` is required: the review skill works every reviewer's
   threads without a `review` section, and asks for the deferral team only
   when it defers a finding.

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
   environment variable overrides both for one run. How far this host trusts
   a drive's passes is only yours to say: a repository's file refuses
   [those fields](CONFIGURATION.md#a-hosts-opt-in-to-bypass). The
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
   https://github.com/jig-harness/jig/blob/main/plugin/README.md#install-the-plugin).
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
         "source": {
           "source": "git",
           "url": "https://github.com/jig-harness/jig.git",
           "ref": "stable"
         }
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
tracker scripts require on Linear and Jira (`issue_tracker.adapter: linear` or `jira`), and, on Jira, `issue_tracker.jira.site`; on GitHub
Issues, the default, the key is the repository's own
(`issue_tracker.github.repository`, by default the git remote's: `repository.remote`, else `origin`), so no
team is set. A drive does not need an AI reviewer: without one it
converges on review threads and CI alone. A repository that has one names it
with `review.reviewer_app` (or `review.reviewer_check_pattern`), and the drive
then also waits for the check run, sticky comment and reviewed-commit marker,
or for a reviewer that submits pull-request reviews (CodeRabbit, named by
`reviewer_app: coderabbitai` alone) its review of the head, as described in the
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
  pass_deadline_retries: 2    # passes killed at their deadline one drive restarts from, across re-arms; default 2
  pass_model: sonnet          # model each pass runs on: a model id, a Claude Code alias or a routing tier; default sonnet
ci:
  required_checks: [build, test]   # check runs that must complete on the final head; default: what the base branch's protection requires
  hold_label: ci:hold         # label your workflows honour to skip heavy jobs between review rounds; default: none (every push runs full CI)
issue_tracker:
  adapter: github             # which tracker adapter to use: github (GitHub Issues, the default), linear or jira
  # team: ENG                 # Linear's team key or Jira's project key, required by those adapters
  file_command: /jig:file-issue   # how an agent files an issue by hand
  taxonomy: label-taxonomy.yaml   # the label taxonomy file-issue validates against; default label-taxonomy.yaml
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
  arm_drive: auto             # how do-item and drive-pr start a drive: auto (a terminal tab in Orca, else the background), tab, background or print; default auto
work_batch:                   # how work-batch sizes a batch
  point_budget: 16            # default 16
  max_items: 6                # default 6
  sizes: [xs, small, medium, large, xl]     # example, no default: every size label, for the labelling-gap report; unset, that report is off
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
leases (a [lease](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is a short-lived claim that one session owns the pull
request's threads) outside the repository, in one SQLite database per
machine, `~/.local/state/jig/drive-pr/state.sqlite` by default, keyed by
clone, with a per-clone folder beside it for its logs:
`~/.local/state/jig/drive-pr/<clone>/`. Set `DRIVE_PR_STATE_DIR` to relocate
that root. A clone's folder an earlier release filled with state files is
read into the database once and left in place. Existing flat overrides
refuse until their artifacts' owners are established. To move the root, stop
every drive, move it whole and export the new one (see the
[drive-pr README](skills/drive-pr/README.md#relocating-the-state-dir)). The
[verification-fit](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) log (the agent's recorded verdicts on whether each round's
required validation was worth its cost) defaults to the Jig state
folder too; `JIG_VERIFICATION_FIT_LOG` overrides it.

**How the skills reach the issue tracker.** `do-item` and `drive-pr` talk to
the tracker only through a small [tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (read an issue with its
comments, list its children, change its state, post a comment, run the
reports' queries). An *adapter* implements that interface for one tracker;
`issue_tracker.adapter` chooses it: `github` for GitHub Issues (the default), `linear` or `jira` (Jira Cloud).
`issue_tracker.states` translates the skills' state names (`in_progress`,
`done`, …) into the tracker's own; on GitHub Issues an open state is a label
or a Projects board's option, and a closed one the reason the issue was
closed ([`issue_tracker.github`](CONFIGURATION.md#issue_tracker)). Supporting another tracker means adding an
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
  lint_command: "bun scripts/check-descarring-scars.ts"   # scar lint taking document paths; default: detected, else the docs skill's lint
docs:
  root: docs                          # the governed docs tree; default: detected (docs/, doc/, documentation/)
  schema: docs/.frontmatter-schema.yaml   # default: detected under the docs tree, else no frontmatter check
  stale_after_days: 180               # a draft older than this is reported stale; default: 180
  promoted_statuses: [approved, active]   # statuses the scar lint holds to no review scars; default: [approved]
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
  them. The guard counts distinct response ids from Codex token usage
  records, resets at each task-start event, and warns near the configured
  budget. The warning does not impose a runtime turn cap.
- **The `review-arbiter` agent is Claude Code only.** Codex plugins carry
  skills, MCP servers, apps and hooks, but not agents; Codex reads custom
  agents only from its own agent folders (`~/.codex/agents/` or a
  repository's `.codex/agents/`). In a Codex session, hand a contested
  finding to a subagent that is given
  [`agents/review-arbiter.md`](agents/review-arbiter.md) as its
  instructions, or define the arbiter once as a Codex custom agent from that
  file.
- **The drive has a pass command for each.** Claude Code's
  (`claude -p "/jig:drive-pr <PR>"`) is the default; Codex's
  (`codex exec "Use the jig:drive-pr skill: /jig:drive-pr <PR>"`, with
  `--dangerously-bypass-approvals-and-sandbox` on a host that set
  [`drive.codex_bypass`](CONFIGURATION.md#a-hosts-opt-in-to-bypass)) is the one
  a drive armed from a Codex session runs, and the one the dispatcher runs on a
  Codex account
  ([start command](skills/drive-pr/README.md#how-to-start-it)). A Codex
  pass runs on the standard tier of `routing.models.codex`, by default
  `terra` (given as `gpt-5.6-terra`); `--pass-model` overrides it with a
  model, a family alias or a tier from `routing.models.codex`. `drive.pass_model` is Claude Code's. Both
  skills arm Codex through a terminal tab or its managed background command
  tool; where the host ends children with the session, keep it alive until
  the drive ends or use an external terminal. The turn-budget hook warns
  under Codex but imposes no runtime turn cap: the pass deadline
  (`DRIVE_PR_PASS_TIMEOUT`, 90 minutes by default) is what ends one that runs
  on, so keep it on for a Codex drive.

## Call a skill's scripts from repository code

Normally only the agent runs a skill's scripts. When a repository's own code
also needs them (for example a sibling skill that imports a shared module, a
status board that runs `await-round.ts`, or a dashboard that asks
`work-batch`'s `candidates.ts --eligibility` which issues may be batched), it
must find the installed copy,
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

- **Update** to the newest version of the channel the machine follows:
  `jig upgrade`, which also refreshes the installed jobs
  ([the `jig` command](#the-jig-command)), or by hand
  `claude plugin marketplace update jig && claude plugin update jig@jig --scope user`
  and `codex plugin marketplace upgrade jig && codex plugin add jig@jig`.
  A tool installs a version only when the plugin's `version` changes, up or
  down (see [release](#releases)). To update without asking, see
  [automatic updates](#automatic-updates).
- **Pin** a machine to one version: add the marketplace at its tag,
  `claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#v0.3.0`,
  or `codex plugin marketplace add https://github.com/jig-harness/jig.git --ref v0.3.0`.
  A pinned machine receives nothing until you move the pin; a tag holds the
  source tree, tests included, where a channel holds the plugin as built.
  Versions are chosen per machine, not per repository: every repository on a
  machine uses the same release, so releases keep reading older configuration
  files unless [CHANGELOG.md](https://github.com/jig-harness/jig/blob/main/CHANGELOG.md) says otherwise.
- **What `main` means:** a marketplace added without a ref follows `main`,
  the source. It receives each version as soon as its release commit lands,
  before that commit's gates have passed, along with the development files.
  It is for working on Jig; every other machine follows a
  [channel](#release-channels). `jig upgrade` says so on a machine that
  follows `main`.
- **Remove**: `claude plugin uninstall jig@jig` and
  `codex plugin remove jig@jig` (add
  `claude plugin marketplace remove jig --scope user` /
  `codex plugin marketplace remove jig` to forget the source too).

## Release channels

A [release channel](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is a branch of this repository that the
tools install from. It
holds the plugin as the tools install it: the two marketplace files and
`plugin/`, without the tests (`__tests__/`) and the instructions for agents
working on Jig itself (`AGENTS.md`, `CLAUDE.md`). Everything else under
`plugin/` is what a skill may rely on at run time. The channels are
generated: every commit on them is written by the release tooling, built
from a version's tag, and records in its message which version it carries
and which commit it was built from.

| Channel | What it carries | When it moves | For |
|---------|-----------------|---------------|-----|
| `stable` | A version that spent 72 hours on `latest` without an open regression | When Jig's maintainers promote a version, or roll back | Most machines, organization rollouts, container images |
| `latest` | Every version | When a version is tagged, which happens once its release commit has passed the gates | Jig's maintainers, and teams that want each change as soon as it ships |

**[Promotion](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).** A version moves from `latest` to `stable` only when all of
these hold, and the promotion command refuses otherwise, naming each
reason:

- it is tagged on `main`, and the tagged commit passed the gates;
- it has been on `latest` for at least 72 hours; a version tagged before
  `latest` existed counts from its tag, since `main` was then the one
  address machines installed from;
- no open issue labelled `regression` is filed against a version the
  promotion would bring to `stable` (one after `stable`'s current version, up
  to this one); a regression issue that names no version blocks every
  promotion until it does;
- it is newer than `stable`'s current version, and no rollback withdrew it.

**Rollback.** When a version on `stable` turns out bad, `stable` goes back to
a version it carried before, as a new commit. Machines on `stable` install
the earlier version on their next update, since both tools install whenever
`version` changes. The versions rolled back over are withdrawn: they never
reach `stable` again, and the fix ships as a new version that goes through
`latest` like any other. A rollback across a breaking release is refused
unless asked for explicitly, since repositories may already have changed
their configuration for it. `latest` has no rollback; it is fixed forward.

**What `stable` gained.** A promotion brings every version after `stable`'s
previous one up to the promoted one; their sections in
[CHANGELOG.md](https://github.com/jig-harness/jig/blob/main/CHANGELOG.md) are what changed. The
[`stable` branch's history](https://github.com/jig-harness/jig/commits/stable)
lists each promotion and the versions it brought.

**Switching channels.** Neither tool re-adds a registered marketplace from
another ref, and removing the marketplace uninstalls the plugin, so a switch
is three steps, and the plugin is uninstalled between the first and the last.
Remove the user-level registration only (`--scope user`): without it, Claude
Code also removes a declaration a repository committed in its
`.claude/settings.json`. The plugin's id stays `jig@jig`, so repositories
that enable it need no change.

```sh
claude plugin marketplace remove jig --scope user
claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#latest

codex plugin marketplace remove jig
codex plugin marketplace add https://github.com/jig-harness/jig.git --ref latest
codex plugin add jig@jig
```

`jig upgrade --channel latest` (or `stable`) on a machine registered at the
other channel stops and prints the removal command for each tool. Switch one
tool at a time (`--claude`, then `--codex`): run its removal command, then
`jig upgrade --claude --channel latest`, which installs it again. The `jig`
command runs the plugin copy a tool names, so it needs one tool that still
has the plugin; with neither, install with the commands above, or with
`bun tools/plugin/setup.ts --channel latest` from a checkout.

### Automatic updates

- **The timers keep the plugin current.** Before resource collection's
  daily run and each dispatcher tick, the job's launcher
  runs the installed plugin copy's `jig upgrade --scheduled`: the update
  `jig upgrade` makes, on the channel each tool follows, then the launcher
  copies and the `jig` command refreshed from the new release. It runs at
  most once per `upgrade.every` (an hour) whichever timer fires first, so
  two timers within the hour upgrade once, and the job then runs the copy
  the upgrade installed. A run already started keeps its files: each
  version is installed in a directory of its own. An upgrade that fails is
  not tried again inside the interval, and the job still runs on the copy
  that is there. Each run's receipt carries an `upgrade` line (withheld,
  skipped, unchanged, `0.114.0 -> 0.115.0`, or failed with the tool's
  error), the [morning report](skills/drive-pr/README.md#the-morning-report)
  lists the updates and failures since the last report, and `jig doctor`
  fails while the latest one failed, or while an upgrade's process died
  before it finished; a `jig upgrade` you run that succeeds clears it. A
  failing tool's output is shortened in each line, so a flood of it never
  stops a job. A machine [pinned](#update-pin-or-remove)
  to a tag receives nothing. A plugin Claude Code loads in place from a
  local marketplace folder is skipped, with the skip in the receipt, and
  the folder is left to whoever maintains it. `jig install --no-upgrade`,
  or `upgrade: off` in the user file, opts the machine out
  ([CONFIGURATION.md](CONFIGURATION.md#upgrade-user-file-only)). The `jig`
  command, a woken dispatcher tick and the dispatcher's change probe never
  upgrade first: only collection's run and the dispatcher's tick do. Only a launcher copy this release or a later one wrote runs
  the upgrade: on a machine whose jobs an earlier release installed, run
  `jig upgrade` (or `jig upgrade --jobs-only`) once, which refreshes each
  job's launcher copy and turns the upgrades on. A machine with no timer
  installed stays on the tools' own updates below, `jig upgrade`, or
  `bun tools/plugin/setup.ts` from a checkout.
- **Claude Code** updates a marketplace added from a Git address only when
  asked, unless auto-update is on for it: `/plugin` → **Marketplaces** →
  `jig` → **Enable auto-update**. On `stable`, turn it on: updates are few,
  and each was proven on `latest` first. On `latest`, it brings several
  versions a day; turn it on if you want each one as it ships.
- **Codex** refreshes a Git marketplace on
  `codex plugin marketplace upgrade jig`, then installs the new version on
  `codex plugin add jig@jig`. `jig upgrade` runs both; run it on a
  schedule if you want updates without asking.
- **The installed jobs** run a launcher copied out of the plugin, which an
  update a tool makes on its own does not refresh. `jig upgrade` refreshes
  them after its own update, the timers after theirs, and
  `jig upgrade --jobs-only` after one a tool made; `jig doctor` says when a
  copy differs from the installed plugin's. A loaded launchd job is
  rewritten only by a `jig upgrade` a person runs, since rewriting it stops
  it.

A session keeps the version it started with; a new session uses the update.

## Where it works

The plugin lives in each tool's user-level plugin directory
(`~/.claude/plugins/`, `~/.codex/plugins/`), so it applies wherever that tool
runs as you:

| Where | What to do |
|-------|------------|
| A terminal session in any clone or worktree | Nothing beyond the one-time install |
| Herdr, Orca, Conductor, or any tool that creates worktrees and starts sessions | Nothing: new workspaces are ordinary directories on a machine that has the plugin |
| `claude -p`, `codex exec`, scripts and loops | Nothing; plugins load in headless runs too |
| A container image or CI runner that runs an agent | Install at image build: run the install commands with git credentials available. For Claude Code, build a read-only *seed* with `CLAUDE_CODE_PLUGIN_CACHE_DIR=/opt/claude-seed claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#stable`, set `CLAUDE_CODE_PLUGIN_SEED_DIR=/opt/claude-seed` at run time, and enable it with `enabledPlugins` ([details](https://code.claude.com/docs/en/plugins/org#seed-containers-and-ci)). For Codex, run the two install commands in the image, or copy `plugin/skills/*` to `/etc/codex/skills/` and `plugin/shared/` to `/etc/codex/shared/`: the scripts import the shared code from the folder beside the skills folder |
| CI jobs that only run tests and gates | Nothing: they do not need the skills |
| A runner that gives each session its own Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) | A user-level install lives in the default directory and is not seen there. Build a seed once (as for containers) and set `CLAUDE_CODE_PLUGIN_SEED_DIR` in the runner's environment; repositories enable the plugin through `enabledPlugins` in `.claude/settings.json` |
| A tool without plugin support | Copy or link every folder of `plugin/skills/` into that tool's user skill directory (for example `~/.claude/skills/` or `~/.agents/skills/`), side by side, and `plugin/shared/` into a `shared/` folder beside that directory (`~/.claude/shared/`, `~/.agents/shared/`): skills import scripts from their siblings and code from `shared/`, so one skill alone, or the skills without `shared/`, do not run. The `jig` skill also reads the plugin's own files from the folder two levels above its `SKILL.md` (the directory that holds the skills folder, such as `~/.claude/`): copy `plugin/README.md`, `plugin/CONFIGURATION.md` and one manifest folder, `plugin/.claude-plugin/` or `plugin/.codex-plugin/`, there too, or its answers come from Jig's repository at a tag and a bug report records the plugin version as unknown. The command name is then the bare skill name |

## Troubleshooting

- **The skill is not in the `/` menu.** Run `jig doctor`
  (or `claude plugin list` / `codex plugin list`). If it is installed, the
  session started before the install: run `/reload-plugins` (Claude Code) or
  start a new session.
- **Install fails with a "repository not found" error.** The address is
  mistyped, or git is set to use a credential that is no longer valid.
  Check with `git ls-remote https://github.com/jig-harness/jig.git`, which
  needs no login. If the error names the ref, check the channel's name: the
  channels are `stable` and `latest`.
- **A scheduled job fails, or stops with "Cannot find the installed jig
  plugin".** Run `jig doctor`: it names the check that fails (an agent
  tool on `PATH` inside a git checkout, a Bun or agent tool the job names
  that has moved, a launcher copy older than the installed plugin, the last
  run's exit) and the command that fixes it.
- **"Already added from a different source"**, or `jig upgrade` saying the
  marketplace is registered elsewhere: the machine follows another channel
  or address. See [switching channels](#release-channels).
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
each tool, listing one plugin, the `plugin/` directory. Each
[release channel](#release-channels) carries the same layout, built from a
version's tag without the development files:

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

The plugin also registers an [agent-runtime hook](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), the
turn-budget guard (`hooks/turn-budget-guard.ts`): before every tool call it
counts the session's agentic turns off the transcript and, within 50 turns of
the runtime's cap of 1000, hands the agent a wrap-up instruction, so an
unattended session writes its handoff before the runtime aborts it. It reads
local files only, lets the call through whenever it cannot count (and says so
as a hook error), and is off with `JIG_TURN_BUDGET=0`; its knobs are in
[CONFIGURATION.md § Environment variables](CONFIGURATION.md#environment-variables)
and the practice is [M1's rung](https://github.com/jig-harness/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md#core-pieces).

## Releases

Every merged change to `plugin/` is released as a new version, tagged
`v<version>` and described in [CHANGELOG.md](https://github.com/jig-harness/jig/blob/main/CHANGELOG.md). A release run
writes the waiting changes that ask for a release as one version, the largest
bump any of them asks for, so merges that landed before the run share a
version. Each tagged version reaches the `latest`
[channel](#release-channels), and a version that proves itself there is
promoted to `stable`. Machines receive a version on their next update.
Repositories need no change unless the changelog says so.

The plugin's name, `jig`, and the marketplace's never change: a new name
would be a new plugin to every machine and every repository that enables
`jig@jig`. Both plugin manifests carry the version, and it moves with every
release.

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
3. To keep the history of the drives' state, move each per-clone directory
   under `~/.local/state/groundwork/drive-pr/` to
   `~/.local/state/jig/drive-pr/` before the first drive runs; the database
   reads each one in at its first open. An override already containing
   per-clone directories needs no move for this rename. A flat
   `DRIVE_PR_STATE_DIR` still needs the explicit relocation in the
   [drive-pr README](skills/drive-pr/README.md#relocating-the-state-dir).
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
