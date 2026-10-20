# drive-pr

**What problem it solves.** An AI-reviewed pull request (PR) rarely settles in
one pass: a reviewer posts findings, someone fixes them, the reviewer looks
again, and the loop repeats until nothing is left. Done by hand, that loop
depends on an agent session remembering where it stood, and it ends badly in
quiet ways: a session declares the PR finished while a reviewer is still
running, a fix is pushed to a PR that has already merged, or a long drive dies
with its context and nobody notices.

**What it does.** `/jig:drive-pr` is a [PR drive loop](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): it runs a PR's [review rounds](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) unattended until the PR reaches exactly one [terminal state](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). Each round it waits for the reviewers to settle, triages every finding to one recorded outcome, implements the accepted fixes, runs the validation plan for the change, pushes, resolves the answered threads, and repeats. Each round is a fresh agent process, so a long drive never depends on one session surviving.

A few behaviours worth knowing before you arm one:

- **Drafts.** It works [draft PRs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) from the start and marks them Ready for review after its first completed round (or the round, or the convergence, `pull_requests.mark_ready` names), so reviewers that skip drafts (often billed per review) see an already-cleaned head.
- **CI.** Before reporting success it waits for the repository's [required checks](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) in continuous integration (CI) to pass on the exact final commit. A repository whose CI is expensive can opt into a [CI hold](#ci-hold), which skips the heavy jobs between review rounds and runs them in full once at the end.
- **Repairs.** When that final CI comes back red, or the PR conflicts with its base and no findings are left, it runs a bounded **repair round** (a CI repair, or a base merge with conflict resolution) and checks again, stopping only once that budget is spent.
- **Stops.** It stops on a state it names precisely — convergence verified against the exact commit, a merged or closed PR, a conflict it could not resolve, findings that need a human decision ([HITL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) — or on one of the operational stops in [the exit table](#the-exit-states--what-you-do-now).
- **Limits.** It never approves, never merges, and never bypasses a hook.

The practice it implements is Jig's [M7 — PR lifecycle & review](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md); its loop-cost reports belong to [M11 — Process observability](https://github.com/jig-harness/jig/blob/main/modules/M11-process-observability/README.md).

This page is for **you, the human** — the operator contract agents follow is the skill itself: [`SKILL.md`](SKILL.md) and [`terminal-states.md`](references/terminal-states.md).

## Installation

The skill ships in the `jig` plugin, installed once per machine for
Claude Code and Codex; see [Jig's skills](../../README.md#install-the-plugin).
In a session it is `/jig:drive-pr`. Its scripts run from the plugin
directory with [Bun](https://bun.sh) and act on the repository the agent is
working in, so the target repository needs no copy of the skill. Git and an
authenticated GitHub CLI (`gh`) are also required, and each round runs the
sibling [`resolve-review-comments`](../resolve-review-comments/README.md)
skill's scripts from the same plugin.

Commands on this page write the skill's directory as `<skill-dir>`: the
`plugin/skills/drive-pr` directory inside the installed plugin (Claude Code
substitutes it as `${CLAUDE_SKILL_DIR}` in the skill itself). Run every
command from the root of the repository whose PR is being driven.

Windows requires Git for Windows. Commands run in native PowerShell and
POSIX shells. The authenticated end-to-end smoke — picking an item, opening a
draft PR, arming a drive, completing a round, and stopping it — is pending.

For Windows `.cmd` or `.bat` pass launchers, arguments cannot contain carriage
returns, newlines or null bytes. Supply multiline
prompts through a file or standard input using the agent CLI's input options.
Batch wrappers that forward all arguments are supported only in npm's generated
`_prog` form, with or without the interpreter arguments npm copies from the
entry point's first line. Those arguments must be plain words: one containing
a quote or a cmd character (`%`, `^`, `&`, `|`, `<`, `>`, `(`, `)`, `!`), such
as `--title="x"`, is refused. A wrapper that also sets environment variables,
or any other forwarding wrapper, is refused too. In each case, launch the
underlying executable and its JavaScript entry point directly. A launch whose
command line would exceed cmd.exe's 8,191-character limit, either as escaped
or once the npm wrapper expands its own variables, is refused as well; pass
long input through a file or standard input.

## Consumer configuration

Each repository keeps its values in `.config/jig.yaml`, the
same file [`resolve-review-comments`](../resolve-review-comments/README.md#consumer-configuration)
reads. Every field below is optional: a repository that sets none of them still
drives, on the defaults shown. A file that exists but cannot be parsed, or a
field of the wrong type, is an error rather than a silent default — except for
`review.bots`, `drive.escape_baseline_doc` and the `fleet_health` fields, which
the drive reads best-effort and replaces with the default when mistyped.

| Field | What it does | Default |
|-------|--------------|---------|
| `review.reviewer_app` | The GitHub App slug whose check runs, and whose sticky summary comment (posted as `<app>[bot]`), are the AI reviewer's evidence for convergence. Setting it, or `review.reviewer_check_pattern`, is what tells the drive the repository has an AI reviewer to wait on. `DRIVE_PR_REVIEWER_APP` overrides it | None. With neither field set, no reviewer is expected. With only the pattern set, reviewer check runs are recognised by name alone from any app, and the sticky comment is accepted only from a login listed in `review.bots` |
| `review.reviewer_check_pattern` | Anchored regular expression (case-insensitive; POSIX classes such as `[[:space:]]` are accepted) naming the posting reviewer's check run. Setting it, like `review.reviewer_app`, makes the drive expect a reviewer. `DRIVE_PR_REVIEWER_CHECK` overrides it | `^ai[ _-]?review(\s*\(.+\))?$`, used once a reviewer is expected |
| `review.sticky_marker` | Text that identifies the reviewer's sticky summary comment. Read only when a reviewer is expected. `DRIVE_PR_STICKY_MARKER` overrides it | `<!-- ai-code-review -->` |
| `review.reviewed_sha_marker` | Marker the reviewer stamps the commit it reviewed with, inside that comment. Read only when a reviewer is expected. `DRIVE_PR_SHA_MARKER` overrides it | `ai-reviewed-sha` |
| `review.severity_formats` | How a reviewer writes a finding's severity, which the decline ladder and the `severity` line of the loop-economy report read: a list of `{login, shape, severities}`, one entry per login, tried before the built-in formats and read only on comments that login posted ([severity formats](../../EXTENDING.md#severity-formats), [fields](../../CONFIGURATION.md#review)) | None: the built-in formats only |
| `repository.base_branch` | The integration branch. A round diffs against its pull request's own base (`origin/<base>`), so a stacked layer's plan and change set cover that layer alone; it diffs against this branch only on a branch known to have no pull request (a detached HEAD has to name its pull request). A pull request whose base cannot be read or fetched, or whose repository is not `origin`'s, is refused rather than diffed against another branch. A walk down a stack for its required checks stops here. `DRIVE_PR_BASE_BRANCH` overrides it | Derived: the clone's `origin/HEAD` when it has one, else the `defaultBranchRef` field from `gh repo view`, cached per process |
| `drive.validation_plan_command` | A command that reads the changed files (one per line) on stdin and prints the validation plan as JSON on stdout: `{validation: {localChecks: [...], verificationChecks: [...], testbox: {required, command, warmupCommand, requiredBy}}, reviewSkills: [...]}`. `round-plan.ts` runs it through the shell from the repository root | Unset: the plan is the single local check `gates.command` |
| `drive.load_guard_command` | A command `round-plan.ts` runs (in text mode) before printing the plan, which waits until the machine's load allows heavy checks | Unset: no load guard |
| `drive.change_areas_catalog` | Path, relative to the repository root or absolute, to a [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): YAML whose `areas:` map holds area key → `{paths: [globs], ...}`. `verification-fit.ts` validates `--area` against its keys, and refuses (exit 2, naming the field) a catalog whose `paths`, `generated[].source`, `labels` or `tracker` fields are malformed; the rest of the catalog schema is not checked | Unset: `--area` is recorded unchecked and the script reports the catalog as not configured |
| `drive.reviews_drafts` | `true` or `false`: does the AI reviewer review draft PRs. The drive uses it only to explain a draft PR that has no reviewer check run yet (`/jig:do-item` also reads it to decide whether new PRs open as drafts) | Unset: unknown, and no hint is given |
| `ci.required_checks` | The exact check names that must complete on the converged head before the drive certifies it (and, with a hold, that must run again after the hold is removed). `[]` means none: the drive relies on the overall CI verdict alone, which is green even when no CI has registered on the head. Without a hold, the drive judges each required check as branch protection does: a skipped or neutral result passes, and a legacy commit status of that name can stand in for a check run. With a hold, required checks must be check runs, since only a run's id proves it ran after the hold was removed. Unrelated to `review.required_checks`, which names the review skill's reviewer checks | Derived: the checks the pull request's base branch requires, from classic branch protection and active rulesets together. For a stacked layer, whose base is a feature branch, the checks of the branch the stack's bottom layer targets are added to the base's own. A check that protection pins to a GitHub App counts only when that app publishes it, as a check run or a commit status; a check pinned to several apps (classic protection to one, a ruleset to another) needs a passing result from each. When the base requires none, the drive also waits until some non-reviewer CI has registered on the head; where a reviewer is expected, a commit status named like the reviewer's check does not count. A base branch, integration branch, stack or protection that cannot be read is an error that asks for this field; the drive never falls back to another branch's protection |
| `ci.hold_label` | A label the repository's workflows honour on intermediate pushes: while it is present they skip their expensive jobs, and removing it runs them in full (see [§ CI hold](#ci-hold)). Requires `ci.required_checks`, listing only checks that run again when the label is removed | Unset: no hold. Every push runs the repository's normal CI and the drive never adds or removes a label |
| `pull_requests.mark_ready` | When the drive marks a draft Ready: a round number N (after round N completes), `converged` (only when the draft-reviewing reviewer has nothing left), or `never`. A draft that converges before round N is marked at convergence | `1`: after the first completed round |
| `drive.max_rounds` | Whole number ≥ 1: how many rounds a drive runs before it stops unconverged (exit `6`). `--max-rounds N` overrides it for one run; a malformed value stops the drive with exit `1` unless the flag names the budget | `10` |
| `drive.escape_baseline_doc` | Path, relative to the repository root, to the document recording the human-judged defect-escape baseline (`## Baseline window: <from> → <to>` headings, each followed by an `**Escape rate: <n> of <total> ...**` line). The loop-cost reports print its latest figure next to their speed numbers | `docs/review-loop-baseline.md`; a missing document reads as "unmeasured" |
| `fleet_health.config` | Path, relative to the repository root or absolute, to the fleet-health settings file that `fleet-health.ts` and the per-round fleet-health warnings read ([format](../../CONFIGURATION.md#the-fleet-health-file)) | `.config/fleet-health.yaml` |
| `fleet_health.snapshot_dir` | Where the gate reads a `fleet-health.json` snapshot from (`~` is expanded). Jig writes no such snapshot: an external collector publishes it, if the machine runs one, and without one the per-round fleet-health warnings are empty. `DEV_DASHBOARD_DIR` overrides it | `~/.local/state/jig/dashboard` |

Every field of the file, for every skill, is in the plugin's
[configuration reference](../../CONFIGURATION.md).

**Ignore `.context/`.** The drive keeps working files (its handoff note,
mailbox, foreground-wait records) in `.context/` at the root of the working
tree, and it refuses to push or certify a tree with untracked files. Add
`.context/` to the repository's `.gitignore`.

The foreground supervisor establishes its process identity before starting the
command. If it cannot establish ownership, the command does not run and the
wait reports failure. Foreground waits preserve a command's exit status
separately from confirmation that its process tree stopped. An unverified tree
makes the helper fail even when the command exited successfully, and blocks
another launch while keeping the earlier generation's process evidence.

The drive also uses two fields `resolve-review-comments` already reads:
`gates.command` (the complete local checks) and `review.bots` (reviewer
identities). `review.job_pattern` and `review.required_checks` govern only the
review skill's own passes; the drive's convergence decision does not read them.
Where the drive reaches the issue tracker (the human-checkpoint check before it
arms, and the fleet-health and program-wide metrics reports), it uses the
`issue_tracker` settings `/jig:do-item` documents.

**Whether the drive expects an AI reviewer at all.** Only when the repository
names one, with `review.reviewer_app` or `review.reviewer_check_pattern` (or
their `DRIVE_PR_REVIEWER_*` overrides). A repository that names neither has no
reviewer to wait on: the drive reads no reviewer check run, sticky comment or
stamp, counts a check that merely looks like a reviewer's as an ordinary check
in the CI verdict, and certifies convergence from zero unresolved threads, zero
unaddressed summary findings and the CI checks below. `review.bots` alone does
not make a reviewer expected; it still names the logins whose threads the
review skill resolves. A repository that has an AI reviewer says so in its
configuration, or the drive converges without it.

**What the drive requires of an expected AI reviewer.** Having the review skill
configured is not enough to drive. Once a reviewer is expected, the drive
certifies convergence from one posting reviewer that provides all of these:

- a check run whose name matches `review.reviewer_check_pattern`, from
  `review.reviewer_app` when one is set;
- a sticky summary comment carrying `review.sticky_marker`;
- in that comment, the commit it reviewed, stamped with
  `review.reviewed_sha_marker`.

Jig ships no reviewer that implements this protocol. The defaults in the
table above are configuration: a repository changes them to match its own
reviewer's check run, comment marker and commit stamp
([fields](../../CONFIGURATION.md#review),
[AI reviewers](../../EXTENDING.md#ai-reviewers)).
A reviewer without that protocol, such as CodeRabbit on its own, never
produces the evidence, and the drive waits in `AWAITING_REVIEWER` until
`--timeout`. This requirement is not checked before a drive starts.

Final certification then waits for the repository's required
continuous-integration checks (`ci.required_checks`, by default the ones its
base branch's protection requires) to complete on the exact converged head,
and for the overall non-reviewer CI verdict to be green.

A minimal configuration for a repository whose AI reviewer is a GitHub App and
whose base branch is not the clone's default:

```yaml
gates:
  command: bun run gates
review:
  bots: ["my-reviewer[bot]"]
  reviewer_app: my-reviewer
repository:
  base_branch: main
drive:
  reviews_drafts: true
```

Machine-level settings are environment variables rather than repository
configuration, because they describe one machine's layout:

| Variable | What it does | Default |
|----------|--------------|---------|
| `DRIVE_PR_STATE_DIR` | The drive's state directory (see § Where its state lives) | `~/.local/state/jig/drive-pr/<clone-key>/` |
| `JIG_VERIFICATION_FIT_LOG` | Where `verification-fit.ts` appends its verdicts | `~/.local/state/jig/verification-fit.jsonl` |
| `DRIVE_PR_REAPER_LAUNCHD_LABEL`, `DRIVE_PR_REAPER_CRONTAB_MARKER` | Name a scheduled `bun "<skill-dir>/scripts/reap-state.ts" --delete` job, so `migrate-state-dir.ts` refuses while it is enabled | Unset: no schedule is checked |

### CI hold

Without a hold, every intermediate push runs the repository's full CI, and
the drive simply waits for it on the final head. A repository whose CI is too
expensive for that can let the drive suppress it between review rounds:

1. Name a label in `ci.hold_label` and list `ci.required_checks`.
2. Make every workflow that reports a required check, and every one with
   expensive jobs, honour it in the shape
   [M13's piece 7](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/README.md#7-hold)
   states. Trigger on `labeled` and `unlabeled` beside `opened`,
   `synchronize` and `reopened` (listing any type replaces the defaults):
   without `labeled`, applying the label starts no run and every required
   check keeps its pre-hold result until the next push, which may never
   come; without `unlabeled`, the release runs nothing again. Skip the
   heavy jobs by testing the pull request's labels for the hold label,
   `!contains(github.event.pull_request.labels.*.name, '<label>')`, never
   by the event's action: with label events starting runs, a job that
   skipped on any `labeled` event would let an unrelated label replace a
   failing head's result with a passing skip, so an unrelated label event
   on an unheld pull request runs real CI. And fail, rather than skip, a
   required check while the label is present, from the run the label's
   application starts onward, with a message naming the label, so a held
   head is visibly not mergeable throughout. M13's
   [workflow-convention lint](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/reference/workflow-conventions/README.md#ci-hold)
   checks all three.

The drive then adds the label before its first intermediate push, once the
PR-open run of every required check has completed, and records the GitHub
timeline event that added it. At convergence it removes the label only if
that event is still the newest transition of the label (a person who removes
and re-adds it takes control), and certifies the head only on required checks
that started after the removal. When someone else removes the label, the
drive accepts only checks that started strictly after that removal; GitHub
records the removal to the second, so a run that started in the same second
has to be rerun. A drive that dies mid-round leaves the label
behind; see [§ The exit states](#the-exit-states--what-you-do-now) for the recovery.

### Push hold

`guarded-push.ts` refuses to push while an orchestrator has sent the PR a
`hold-push` directive (`bun "<skill-dir>/scripts/mailbox.ts" send`). A hold sent while the push's own
pre-push hooks are already running lands after that check, so a repository
that wants those holds honoured too runs `push-hold-recheck.ts` as its last
pre-push hook command. `guarded-push.ts` arms it by exporting
`DRIVE_PR_HOLD_RECHECK_PR`; an ordinary push skips it before `bun` starts:

```sh
bun "<skill-dir>/scripts/push-hold-recheck.ts"
```

It must run after every other pre-push command, or a later one reopens the
window it closes.

### Limits you can tune

Each is an environment variable read by the drive (and, where noted, a flag on
`drive.ts`). The defaults suit most repositories; raise a deadline when a
legitimate step keeps hitting it, rather than removing it.

| Variable | What it bounds | Default |
|----------|----------------|---------|
| `DRIVE_PR_CI_REPAIR_ROUNDS` | CI-repair passes after the final CI comes back red (`0`: stop on the first red) | `2` |
| `DRIVE_PR_CONFLICT_REPAIR_ROUNDS` | Conflict-resolution passes when the PR conflicts with its base and nothing else is left (`0`: stop at once) | `1` |
| `DRIVE_PR_FINAL_CI_WITNESS_POLLS` | How long to wait for the required checks to report on the final commit, in 10-second polls (`0`: wait forever) | `180` (30 minutes) |
| `DRIVE_PR_STALL_ROUNDS` | Consecutive rounds that change nothing before the drive stops with exit `14` (`0`: off) | `2` |
| `DRIVE_PR_PASS_TIMEOUT` | One round's agent pass, in seconds; also `bun "<skill-dir>/scripts/drive.ts" --pass-timeout` (`0`: off) | `5400` (90 minutes) |
| `DRIVE_PR_QUOTA_MAX_SLEEP_SEC` | The longest usage-limit reset the drive sleeps through rather than stopping with exit `16` | `21600` (6 hours) |
| `DRIVE_PR_PAUSE_MAX_SEC` | How long a mailbox `pause` may last before exit `19` | `1800` (30 minutes) |
| `DRIVE_PR_PUSH_TIMEOUT` | One `git push`, pre-push hooks included, in seconds | `3600` |
| `DRIVE_PR_HELPER_TIMEOUT` | One helper script the drive spawns, in seconds | `120` |
| `GH_CALL_TIMEOUT` | One `gh` call, in seconds | `30` |
| `DRIVE_PR_STALL_MIN` | Minutes without progress before `bun "<skill-dir>/scripts/drives.ts" --doctor` calls a live drive wedged (never below the default) | `240` |

The remaining `DRIVE_PR_*` variables (lock and lease timing, and the ones
`drive.ts` sets for its own passes) are documented where they act, in
[`SKILL.md`](SKILL.md) and [`terminal-states.md`](references/terminal-states.md).

### The background time limit

None of the limits above bounds the whole drive, but the harness that starts
it can. In Claude Code, a session that runs unattended (`claude -p`, the Agent
SDK, a cloud or scheduled session) stops a background command after 30
minutes, or after the `timeout` the agent passes with `run_in_background`, and
by default never later than 2 hours (the machine can raise that ceiling, see
below). A `claude -p` run whose prompt is passed as text
rather than with `--input-format stream-json` uses 10 minutes instead of 30.
From Claude Code 2.1.288, a local terminal session, the desktop app and the
editor extensions have no such limit; from 2.1.285 to 2.1.287 the limit
applies in every session. A drive runs as many rounds as its round budget
allows (`drive.max_rounds`, 10 by default), each up to 90 minutes, so
an agent that starts it without a `timeout` sees it stopped at the default
limit, partway through a round, with no exit state of its own.

Stopping the driver stops its pass, and the pass's agent context is lost;
nothing else is rolled back. Edits in the worktree, local commits not yet
pushed, and anything already pushed or posted stay where they are. Before
re-arming, check `bun "<skill-dir>/../../shared/command.ts" -- git status --short` for uncommitted work and
`bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count '@{u}..HEAD'` for unpushed commits, and finish or discard
them. The next drive recovers the stale locks and resumes at the same round
from the saved state, and a Ready mark already made stays made.

Two settings raise the limit to 8 hours, and both are needed for a drive
longer than 2 hours:

- The skills tell the agent to pass `timeout: 28800000` (8 hours) when it
  spawns the driver.
- The machine raises the harness's ceiling: set `BASH_MAX_TIMEOUT_MS` to
  `28800000` in the `env` block of `~/.claude/settings.json` (or in the
  environment of whatever launches the session). Without it the agent's
  `timeout` is held to 2 hours. Leave `BASH_DEFAULT_TIMEOUT_MS` alone: it also
  sets the default timeout of every foreground command.

Eight hours does not cover every drive the driver itself allows. A quota
sleep can last up to `DRIVE_PR_QUOTA_MAX_SLEEP_SEC` (6 hours by default)
between passes, and a long `--max-rounds` adds 90 minutes a round, so such a
drive is stopped at 8 hours all the same. Re-arm it after the checks above;
it resumes where it stopped. A drive likely to run past the ceiling is better
started outside the harness (a terminal or terminal-multiplexer pane of its
own). Run the same `bun` command there, redirecting output to a file if
needed, and stop it with `bun "<skill-dir>/scripts/drives.ts" --stop <PR>`.
The stop command checks the driver's identity and cancels its active pass
before releasing locks.

Both variables are read when a session starts, so a drive already running
keeps its old limit, and a harness other than Claude Code has its own. Claude
Code needs version 2.1.285 or later for them to take effect.

## When to reach for it

- **A PR exists and you want the review loop run to completion** → this skill. Normally you don't even start it by hand: a `/jig:do-item` run arms the drive when it opens the draft PR. Typing `/jig:drive-pr [PR]` in a session does the same thing: the agent starts the driver below in the background, reports its log path, and stops — it does not work a round itself.
- **You want exactly one round, interactively, with yourself in the loop** → `/jig:drive-pr --interactive [PR]` (one in-session round, then stop), or [`/jig:resolve-review-comments`](../resolve-review-comments/README.md) (the drive wraps it).
- **CI is red and that's the only problem** → repair it directly, with [`/jig:fix-ci`](../fix-ci/SKILL.md). (A drive already in flight repairs red CI itself, up to `DRIVE_PR_CI_REPAIR_ROUNDS` times; repair by hand when there is no drive running, or when its budget is spent.)

## How to start it

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"
```

The `bun` prefix and the single line are deliberate: every TypeScript command explicitly names its runtime. On Windows, run it in PowerShell after installing Git for Windows. It is the same command `/jig:do-item` emits and spawns when it arms the drive for you, and the one `/jig:drive-pr` spawns from a session. The agent tells "a session asking for a drive" from "a pass the driver spawned" by `$DRIVE_PR_TARGET`, which only `drive.ts` sets — so a driver's own passes never arm another driver.

`--bots-only` keeps it off human-authored threads (recommended for unattended runs). `--keep-draft` stops it marking the PR Ready (`pull_requests.mark_ready: never` does the same for every drive). `--max-rounds N` bounds the loop (default `drive.max_rounds`, else 10). `--dry-run` reports what each round would do and never invokes the pass. Starting it twice **in the same clone** is safe — see exit `11`. That is the exact reach: the lock lives in the per-clone state dir described below, so it covers this clone and its linked worktrees and nothing further. A separate clone — another machine, a CI checkout — takes its own lock and can drive the same PR at the same time.

## The exit states — what you do now

| Exit | State | What you do |
|------|-------|-------------|
| `0` | **`CONVERGED`** | The exact head is reviewer-clean, the worktree is clean, the CI hold label (if the repository has one) is absent, and full non-reviewer CI is green with a fresh exact-head witness from the required checks. The merge decision is yours. **One caveat that is not optional:** if this drive marked the PR Ready, convergence is against the draft-reviewing AI reviewer **only** — marking Ready is what summons the reviewers that skip drafts, so anything they post lands *after* the drive ends. The drive says so on stderr; re-run it once they settle. `drive.ts` does **not** post the merge-ready announcement itself — run `bun "<skill-dir>/scripts/announce-merge-ready.ts" <PR>` if you want one on the PR. It re-checks convergence, non-reviewer CI, the absent hold, and a clean worktree before posting. `--dry-run` never invokes a pass, so a `0` from it is either this same convergence (the gate reached it first) or simply the command it *would* have run — the printed output says which. |
| `5` | **PR not open** (`PR_NOT_OPEN`) | The PR merged or closed while driving. Usually nothing to do — but if it happened *mid-round*, `guarded-push.ts` refused the push and **this round's commits are still local**, deliberately, so the work stays visible instead of landing on an orphaned branch. Check `bun "<skill-dir>/../../shared/command.ts" -- git log 'origin/<branch>..HEAD'` and either port those commits somewhere that will merge or discard them on purpose. |
| `8` | **HITL-parked** (`HITL_PARKED`) | Everything left needs a human call — arbiter escalations, human threads, parked summary findings. Read the round report / the `.context/pr-drive-<PR>.md` handoff, decide the parked items, then re-run the same command. It will **not** re-arm itself. |
| `9` | **Conflicting, nothing to work, and the repair budget is spent** (`PR_CONFLICTING`) | Either the drive spent the conflict-repair budget (`DRIVE_PR_CONFLICT_REPAIR_ROUNDS`, default 1) trying to resolve it and could not, or no repair pass ran at all — the budget is `0`/disabled, or the PR's base ref could not be read. Either way, merge the PR's **own base** in — not necessarily the default branch, since a release or stacked PR has a different one. The drive prints the exact command (`bun "<skill-dir>/../../shared/command.ts" -- git fetch origin`, followed on success by `bun "<skill-dir>/../../shared/command.ts" -- git merge origin/<base>`) rather than guessing; use that. Then resolve, run the emitted validation plan, push, re-run. (A conflicting PR gets zero `pull_request` CI until you do.) |
| `12` | **Converged, but the tree is not clean** | The convergence is real; something local is unshipped. The causes and their fixes: uncommitted edits → commit or discard; an unconcluded merge/cherry-pick/revert/rebase/am → resolve or abort it; a local `HEAD` no longer matching the reviewed head → push it or reset. The last two leave `git status` **clean**, so don't stop there — the drive names which probe failed, and [`terminal-states.md`](references/terminal-states.md) lists them all. Then re-run. |
| `4` | Timed out / Ready-lease held elsewhere / no fresh CI witness (`NOT_SETTLED`) | Usually a reviewer that never answered, or another worktree's driver holds the Ready-mark lease. Check the reviewer check-run on the PR; re-run, or find the other driver. A third cause: the review converged and nothing is failing, but no fresh exact-head required-check witness showed up within `DRIVE_PR_FINAL_CI_WITNESS_POLLS` (default 30 minutes) — a required check whose fresh run completed **skipped** can never resolve this by waiting, so re-run the required checks on this head (a fresh run, not `gh run rerun` of the old one) and re-arm. |
| `6` | Max rounds | The bound fired before convergence — often a finding the agent cannot fix, or a reviewer past its own round ceiling. Read the last round report before re-arming with a higher bound. |
| `7` | Reviewer check failed (`REVIEWER_FAILED`) | The reviewer's check-run did not pass, so a "zero threads" read would be meaningless. Look at the check on the PR. |
| `10` | — | Reserved; never returned. |
| `11` | **Another driver is live** | The drive is already armed — in this worktree or another of this clone. Do nothing; do not kill the other driver. |
| `13` | `DRIVE_HELD_BY_OTHER_WORKTREE` | Another live *working tree* is mutating this PR's drive state, possibly through an interactive pass rather than another driver — a case not covered by `11` when the other session is not itself holding `drive.ts`'s PR/worktree locks. Inspect with `bun "<skill-dir>/scripts/drive-state.ts" lease <PR> --all`; wait for the holder, or take over with `bun "<skill-dir>/scripts/drive-state.ts" clear-lease <PR> --all` once you have confirmed it is dead. |
| `14` | **Stalled** | `$DRIVE_PR_STALL_ROUNDS` (default 2) consecutive passes changed nothing this loop can observe — the reviewed head, local head, and every unresolved-thread/summary-finding/parked-key set all came back identical. The usual cause is a pass exiting 0 without acting (for example, standing down against its own parent driver) while the round headers still look healthy. First check what the driven worktree still holds — the stop prints it, and a pass can make correct edits and stall before committing them. Then read the pass output for what it decided, fix why it did not act, then re-arm the same command. |
| `15` | **Pass deadline** | One round's agent pass ran longer than `DRIVE_PR_PASS_TIMEOUT` (default 90 minutes) and was killed. Nothing was rolled back: check `bun "<skill-dir>/../../shared/command.ts" -- git status --short` for an uncommitted fix and `bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count '@{u}..HEAD'` for a committed but unpushed one, keep or discard that work, then re-arm. If a legitimate round needs longer, raise the deadline; if not, look for what hung. |
| `16` | **Quota-parked** | The agent hit a subscription usage limit that will not reset within `DRIVE_PR_QUOTA_MAX_SLEEP_SEC` (default 6 hours) — a weekly limit, or one whose reset could not be read. A short limit never reaches this exit: the drive sleeps through it. Nothing is wrong with the PR. Run the same two `git` checks as for `15`, then re-arm once the limit has reset; starting another session now only hits the same limit. |
| `18` | `MAILBOX_STOPPED` | A mailbox `stop` ended the drive after any active pass and its Ready transition finished. Send `resume --target stop` before re-arming. |
| `19` | `MAILBOX_PAUSE_TIMEOUT` | A mailbox `pause` stayed active for `$DRIVE_PR_PAUSE_MAX_SEC` (default 30 minutes). Send `resume --target pause`, then re-arm. The driver releases its locks on this exit. |
| `1` / `2` | Pass failed / usage error / **CI still red** | Operational. Read stderr; `2` usually means the command line itself is wrong, but can also mean `UNSUPPORTED_CLI` — a `gh` too old to report a required PR field such as draft state or mergeability. For that case, upgrade `gh`; it is not a CI-repair matter. `1` is also the CI stop: the review converged but full CI on the converged head is red and the repair budget (`DRIVE_PR_CI_REPAIR_ROUNDS`, default 2) is exhausted or disabled (`0` skips repair entirely and stops on the first red), or the verdict was unreadable rather than a named failure. Repair CI by hand, then re-arm. |

One red-CI cause is worth ruling out before you repair anything in a repository with a [CI hold](#ci-hold): a drive that **died** mid-round leaves its hold label behind, and the repository's held-head check then fails a required check on a perfectly healthy PR. Check `bun "<skill-dir>/../../shared/command.ts" -- gh pr view <PR> --json labels` first. If it is there, push whatever the dead drive stranded, then `bun "<skill-dir>/../../shared/command.ts" -- gh pr edit <PR> --remove-label "<ci.hold_label>"` — the removal itself retriggers CI. Do **not** `gh run rerun` the old run: it replays the original event payload, which still carries the label, so it fails on the hold step again.

Where the repository turned on the [`changelog`](../changelog/README.md) skill
(`changelog.file` in the `.config/jig.yaml` its base branch holds), a round whose accepted fix
changes what the pull request's change note says updates the note in the same
round. A repository that did not is never asked for one.

## What it will never do

- **Merge, approve, or request changes** on the PR.
- **Mark Ready before a completed round**, mark Ready under `--keep-draft`, or **re-mark a PR you converted back to draft** — the transition is once-only and defers to you.
- **Touch human-authored threads** under `--bots-only`.
- **Resolve an accepted thread before its fix's push is verified** on the remote head — a fix that failed gates is not a fix.
- **Bypass repository hooks or the emitted validation plan.** There is no `--no-verify` path.
- **Start a second loop on the same PR *from this clone*** — the per-PR lock refuses (exit `11`). A drive launched from a *different* clone is outside that lock's reach and is not prevented — see § How to start it.

## Where its state lives

- **The per-clone state dir** — `~/.local/state/jig/drive-pr/<clone-key>/` by default (`resolveStateDir()` in `<skill-dir>/scripts/lib/state/store.ts`; `$DRIVE_PR_STATE_DIR` overrides it — § Relocating the state dir) — the drive state (rounds, attempts, verified commit, parked/held items, Ready-mark round), the round counter, the locks, the leases. Clone-wide by design, *not* worktree-local: every linked worktree driving this PR shares one round budget, one parked set and one held batch, so a second worktree cannot silently re-arm an escalation the first one parked. The locks answer different questions, and only the PR-keyed one bears on "can this PR be driven twice":
  - `pr-drive-<PR>.lock`, keyed by **PR** — refuses a second drive of *this PR* anywhere in the clone (exit `11`).
  - `pr-drive-worktree-<key>.lock`, keyed by **working tree** (the filesystem canonical path of `--show-toplevel`, including Windows path aliases) — stops two drivers colliding over one checkout's files even when they drive *different* PRs. Separate worktrees are meant to run concurrently, so this key deliberately does not gate them.

  Each held item's `actor` stamp reuses that same tree key, but it only **records** which tree made a promise — it grants no exclusivity of its own.
- **`.context/pr-drive-<PR>.md`** — the human-readable handoff: where the drive stands and how to resume.
- **GitHub** — the shared truth: threads and their resolution state, outcome replies, the drive's announce comments, the reviewer check-runs.

The state dir grows with every lock generation. `bun "<skill-dir>/scripts/reap-state.ts"`
(dry-run by default, `--delete` to act) compacts what is still in use on POSIX
systems, retains nonempty [directory fences](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) on Windows, and
deletes the files of merged PRs and removed worktrees; run it weekly from the
machine's own scheduler if you drive many PRs. [`SKILL.md`](SKILL.md) § Running
it (the *State reaping* entry) explains what it may and may not delete.
On Windows, the sweep upgrades older empty file fences by atomically publishing
a complete directory fence. Failed publication retains its staging until a real
nonempty directory fence can be verified. An existing empty directory that
Windows refuses to replace remains unfinished; later sweeps reuse its staged
fence. Nonempty files and symbolic links remain untouched.

On Windows, state writes and lock moves wait briefly for another process's
sharing handle for up to two seconds before reporting failure. Lock failures include the filesystem
error code. The state volume must support hard links; a refusal names
`$DRIVE_PR_STATE_DIR` so you can choose another volume.

## Upgrading worktree identity

Canonical worktree paths can produce different keys from earlier releases,
including Windows path aliases. Existing actor stamps on held items, leases
and worktree locks are not migrated. Upgrade while every participant in a
clone is stopped; mixed versions can otherwise use different locks for the
same checkout. Keep the old plugin copy available until cleanup is complete.
Here, `<old-skill-dir>` means that copy's `drive-pr` skill directory.
Prevent new work and automatic starts or restarts throughout this procedure.
Use each participant's original state-directory configuration. For commands
run from a worktree, unset `DRIVE_PR_WORKTREE` or set it explicitly to that
intended tree; an inherited value overrides the current directory.

1. **Inventory and finish held work with the old version.** Run
   `bun "<old-skill-dir>/scripts/drives.ts" --doctor --json` for its health view
   and reported `stateDir`; its rows omit some held-only and lease-only work.
   Enumerate that actual directory. Include every `drive-pr-<PR>.json`,
   `pr-drive-lease-<PR>-<actor>.json` and `drive-tree-lease-<actor>.json`,
   taking PRs and worktrees from the records' `pr` and `worktree` fields where
   present. Include claims in `pr-drive-<PR>.lock` and
   `pr-drive-worktree-<key>.lock`. Defer on any unreadable or unaccounted record.
   For every inventoried PR, finish pending replies and resolutions through
   the old resolver. Confirm
   `bun "<old-skill-dir>/scripts/drive-state.ts" held <PR>` returns `[]`.
2. **Stop all old participants and repeat the inventory.** Run
   `bun "<old-skill-dir>/scripts/drives.ts" --stop <PR>` for each live drive,
   stop interactive and sessionless resolvers, and disable hooks and scheduled
   reapers that can access this clone's state. Confirm the stop commands
   succeed and the old `drives.ts` listing has no live drivers. Repeat the full
   directory inventory and `held <PR>` checks after shutdown, before clearing
   ownership. If new held work appears, finish it with the old version and
   repeat shutdown and inventory.
3. **Clear old ownership from each worktree.** Verify each lease's actor and
   recorded worktree match the intended stopped tree. Run
   `bun "<old-skill-dir>/scripts/drive-state.ts" clear-lease <PR>` from that
   worktree, using its state-directory configuration and intended tree anchor,
   for every PR it used. The plain command clears both its old-key per-PR lease
   and its tree lease; `clear-lease --all` does not replace this step. Confirm
   the inventoried per-PR and tree lease files were removed; then check
   `bun "<old-skill-dir>/scripts/drive-state.ts" lease <PR> --all` returns `[]`
   for every affected PR, and check the old `drives.ts` listing again.
   The live-lease listing alone does not prove old lease files were removed.
4. **Upgrade together, then resume.** Update every participant before
   re-enabling hooks, reapers or drives. Preserve the state directory, round
   budgets and parked work. Do not reset state or release unfinished held work
   to make the upgrade proceed. If any old participant or ownership record
   cannot be accounted for, defer the upgrade rather than clearing live
   foreign ownership.

## Relocating the state dir

`$DRIVE_PR_STATE_DIR` overrides the default state directory
(`~/.local/state/jig/drive-pr/<clone-key>/`) outright and skips the
legacy-location migration guard. The override does not move existing state:
migrate it using the procedure below **before** exporting the new path, or the
drive can start with an empty round and lease history. The same procedure moves
state left in an older default location into the current one. A legitimate
use: a machine that cannot afford the default location — an IDE or backup
tool watching the whole home directory, say.

**The invariant is that every participant in one clone resolves the same
directory.** Two drivers that disagree do not share the lease mutex: each mints a
fresh, empty state for a PR the other is already driving, which presents as a
drive silently restarting at round 0 with `verifiedSha` cleared while the real
record sits in the other directory. Changing it means changing it everywhere at
once — a machine-wide export in the shell's startup file reaches the
commands that shell starts, agent-tool hooks run in their own environment
and need it in that tool's settings (Claude Code:
`~/.claude/settings.json`'s `env`), and launchd/cron jobs read no shell startup
file and need it written into their own configuration as an absolute path.

1. **Quiesce every participant.** Stop every live `drive.ts`
   (`bun "<skill-dir>/scripts/drives.ts" --stop <PR>` per PR, or wait
   for each to reach a terminal state) and disable any scheduled
   `bun "<skill-dir>/scripts/reap-state.ts" --delete` job (`launchctl unload`, or comment out the
   `crontab -e` entry) — nothing may read or write the state directory during
   the move.
2. **Migrate.** Move a whole state root (one subdirectory per clone), or one
   clone's directory, into the current root:

   ```bash
   bun "<skill-dir>/scripts/migrate-state-dir.ts" --from <old dir> [--to <new root>]
   ```

   `--to` defaults to the current state root
   (`~/.local/state/jig/drive-pr`); `~` is expanded. To move one clone's
   directory to an exact destination instead, pass both absolute paths:
   `bun "<skill-dir>/scripts/migrate-state-dir.ts" /absolute/current/state-dir /absolute/new/state-dir`.

   It refuses unless every source-named driver lock is stale and, when
   `DRIVE_PR_REAPER_LAUNCHD_LABEL` or `DRIVE_PR_REAPER_CRONTAB_MARKER` names a
   scheduled reaper, that schedule is positively verified as disabled. It
   enumerates the artifact population shared with `reap-state.ts`, fails
   closed on any unknown drive-pr-shaped entry, and moves the artifacts rather
   than the containing directory — never the clone's git common directory
   itself, which for the legacy in-repository location *is* that directory
   (normally `.git`). On one filesystem each artifact lands through atomic
   `rename(2)`; across filesystems it copies the population to a private
   staging directory, verifies content hashes, publishes it, and only then
   removes the sources. Success reports every moved name and family after
   verifying that the source has no classified artifacts left and the
   destination has the full population.
3. **Only after that success, export** `$DRIVE_PR_STATE_DIR` at the new path
   (when the destination is not the default) for every participant at once —
   the shell profile and the agent tool's settings. Exporting before the
   migration makes participants mint a fresh state universe at the destination
   while the real record remains at the source. Leave a scheduled job's own
   configuration untouched until this point: re-enabling it before the move is
   confirmed would point the reaper at the old location.
4. **Verify, re-arm and re-enable.** From a fresh shell, run
   `bun "<skill-dir>/scripts/drives.ts"` and confirm that no drives
   remain live from before the move and that the new directory holds the moved
   files. Then re-arm the stopped drives, and update and re-enable any
   scheduled reaper so it picks up the new path.

A machine-wide export reaches every clone on that machine equally, and state
files and locks key only by PR number, never by clone or fork — so one shared
export is safe only on a machine with a **single** clone. A machine running
several independent clones, where the same PR number could name unrelated work
in each, needs distinct, clone-specific values.

## Stopping and resuming safely

- **Stop:** `bun "<skill-dir>/scripts/drives.ts" --stop <PR>` requests shutdown after verifying the driver's process identity. The driver stops the active pass before releasing its locks. On Windows, a polled stop request lets cleanup run without POSIX signals; process snapshots come from PowerShell. Confirmed cleanup publishes a completion receipt for that acquisition before releasing claims. The stop command requires the matching receipt and disappearance of its captured process identities when a temporary shutdown marker made the registry uncertain. Ctrl-C also cancels the active work. Locks a dead driver leaves behind are recovered automatically by the next driver.
- **Resume:** run the same command again. The durable state means it continues rather than restarts, and threads already answered are reconciled rather than re-answered (`reconcile-replied-threads.ts` runs from the gate). A retry against an unchanged head is not a new *reviewed-head* round, but it does spend one of the durable **attempts**; within one uninterrupted drive, consecutive observable no-op passes trip exit `14` (default 2), while retries spread across driver restarts reset that in-memory stall streak and can still exhaust `--max-rounds` with exit `6`.
- **Inspect without touching:** `bun "<skill-dir>/scripts/drive-status.ts" <PR> --json --once --no-count` answers "what would the drive do now" without doing it. `--no-count` is what makes that true — without it the probe *counts* its own evaluation as a round on this head, moving the durable counter that a later drive's `--max-rounds` bound and reflection nudge both read.

If a drive died mid-round hours ago, just re-arm — recovery is the designed path, not an exception.

## Timing traces

Set `JIG_TRACE=1` when starting a drive to see where its time goes. The runtime
writes one JSON object per completed [trace span](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) under
`~/.local/state/jig/traces/<date>/`. `JIG_TRACE_FILE` enables the same records
at a chosen file path. The drive and its children share a trace through
`TRACEPARENT`, so command calls can be followed back to the pass or wait that
started them.

Each record has `trace_id`, `span_id`, `parent_id`, `name`, `start`,
`duration_ms`, `status` and `attrs`. Command records contain the command name,
exit code and timeout information. Arguments, standard input and command
output are excluded. Tracing is disabled unless explicitly enabled.

`reap-state.ts` removes date directories older than 14 days from the default
trace directory. A custom trace file is managed by whoever chose its path.
Timing records help diagnose slow commands and waits; the reviewer-stall
state still requires its own completion policy.

## Changing this skill

Read [`references/consistency.md`](references/consistency.md) first. The
tests live in `__tests__/` and run from the Jig repository root with
`bun test plugin/skills/drive-pr` (the root `bunfig.toml` supplies the test
preloads); they never run from the plugin cache.
The `__tests__/terminal-states*.test.ts` suites check that every terminal
state's exit code agrees across `scripts/`, `SKILL.md`, this page and
`references/terminal-states.md`.
