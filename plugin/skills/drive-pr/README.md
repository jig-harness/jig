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
- **Repairs.** When that final CI comes back red, or the PR conflicts with its base and no findings are left, it runs a bounded **repair round** (a CI repair, or a base merge with conflict resolution) and checks again, stopping only once that budget is spent. A cancelled check is not red: the drive waits for a replacement and spends no repair pass on it. With no active replacement after a 30-second grace period, it requests one re-run per head, recorded durably across re-arms. A refused request or another cancellation parks with the run and recovery for a person. It never replays a run created under the CI hold, and never counts cancellation as passing.
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

Before fixing a finding, the pass records its decline-ladder verdict for the
thread or summary fingerprint and the current review round. Accepted holds
without a matching accepting verdict are refused, so a pass cannot record a
fix promise before completing triage.

Commands on this page write the skill's directory as `<skill-dir>`: the
`plugin/skills/drive-pr` directory inside the installed plugin (Claude Code
substitutes it as `${CLAUDE_SKILL_DIR}` in the skill itself). Run every
command from the root of the repository whose PR is being driven.

Windows requires Git for Windows. Commands run in native PowerShell and
POSIX shells. The authenticated end-to-end smoke — picking an item, opening a
draft PR, arming a drive, completing a round, and stopping it — is pending.
Native Windows validation also excludes named multi-round and long-CI
driver fixtures and the large post-retirement census fixture until their
startup and filesystem work fit the existing test budgets. Other tests of
these behaviors continue to run.

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
| `review.skip_notice_marker` | Marker around the reviewer's notice, inside that comment, that it did not review a pushed commit (`<!-- <marker> -->` … `<!-- /<marker> -->`, naming the commit). A skipped head whose pull-request diff equals the reviewed one's converges on that review; any other skip of the head stops the drive (`22`). Read only when a reviewer is expected. `DRIVE_PR_SKIP_NOTICE_MARKER` overrides it | `ai-review-skip-notice` |
| `review.bots` | The review bots, each a login or `{login, confirmation_marker, chat_marker}`. A comment after a held reply is **transparent** (resolves with the hold, and is never triaged or answered) when no line of it opens with an outcome token and it carries its author's confirmation marker, or, for a listed bot, its chat marker and no severity line of the bot's finding shape. A bot the list leaves out, or one without a severity format known to be its own (declared in `review.severity_formats`, or built in; Jig's format, assumed for the configured reviewer, does not count), gets no transparent chat follow-ups; CodeRabbit's measured confirmation marker (`<!-- coderabbit-skip-review-comment-follow-up -->`) applies listed or not, and its chat marker (`<!-- coderabbit-ai-generated:v1 -->`) once `coderabbitai[bot]` is listed. To stop CodeRabbit's chat replies at the source, set `chat.auto_reply: false` in its `.coderabbit.yaml`: its reviews, confirmations and tagged commands stay | None: only CodeRabbit's confirmations are transparent |
| `autonomy.level`, `autonomy.max_level`, `autonomy.park_classes`, `autonomy.off_hours` | How far a pass decides without asking, the repository's ceiling for that, the decision classes a park may name, and the level for the hours nobody is there to ask ([autonomy](../../CONFIGURATION.md#autonomy)). The driver prints the level and its source at the start of every round, `wide (off_hours)` inside an off-hours window. A drive reads the ceiling and the park classes from the branch the pull request targets, so a change to them applies to a pull request once it is on that branch (for a stacked layer, the layer below); when that branch cannot be read, the drive runs `attended` and parks every decision for you | `attended`, a ceiling of the repository's own level, the registry template's classes plus `escalated` and `human-decision`, and off-hours off |
| `review.severity_formats` | How a reviewer writes a finding's severity, which the decline ladder and the `severity` line of the loop-economy report read: a list of `{login, shape, severities}`, one entry per login, tried before the built-in formats and read only on comments that login posted ([severity formats](../../EXTENDING.md#severity-formats), [fields](../../CONFIGURATION.md#review)) | None: the built-in formats only |
| `review.code_scanning_severities` | Partial overrides of GitHub code-scanning alert levels to `blocker`, `high`, `medium` or `low`. Thread triage and loop metrics read the alert's security level first, otherwise its rule level; unreadable alerts stay `unknown` ([fields](../../CONFIGURATION.md#review)) | `critical/high/medium/low` → `blocker/high/medium/low`; `error/warning/note` → `high/medium/low` |
| `repository.base_branch` | The integration branch. A round diffs against its pull request's own base (`<remote>/<base>`, the remote being `repository.remote`), so a stacked layer's plan and change set cover that layer alone; it diffs against this branch only on a branch known to have no pull request (a detached HEAD no attach recorded has to name its pull request). A pull request whose base cannot be read or fetched, or whose repository is not the remote's, is refused rather than diffed against another branch. A walk down a stack for its required checks stops here. `DRIVE_PR_BASE_BRANCH` overrides it | Derived: the clone's `<remote>/HEAD` when it has one, else the `defaultBranchRef` field from `gh repo view`, cached per process |
| `repository.remote` | The git remote the drive pushes to and fetches from, and whose `HEAD` names the integration branch. Its fetch and push addresses must name the pull request's repository, or the drive refuses to fetch the base or to push | `origin` |
| `drive.validation_plan_command` | A command that reads the changed files (one per line) on stdin and prints the validation plan as JSON on stdout: `{validation: {localChecks: [...], verificationChecks: [...], testbox: {required, command, warmupCommand, requiredBy}}, reviewSkills: [...]}`. `round-plan.ts` runs it through the shell from the repository root | Unset: the plan is the single local check `gates.command` |
| `drive.load_guard_command` | A command `round-plan.ts` runs (in text mode) before printing the plan, which waits until the machine's load allows heavy checks | Unset: no load guard |
| `drive.change_areas_catalog` | Path, relative to the repository root or absolute, to a [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): YAML whose `areas:` map holds area key → `{paths: [globs], ...}`. `verification-fit.ts` validates `--area` against its keys, and refuses (exit 2, naming the field) a catalog whose `paths`, `generated[].source`, `labels` or `tracker` fields are malformed; the rest of the catalog schema is not checked | Unset: `--area` is recorded unchecked and the script reports the catalog as not configured |
| `drive.reviews_drafts` | `true` or `false`: does the AI reviewer review draft PRs. The drive uses it only to explain a draft PR that has no reviewer check run yet (`/jig:do-item` also reads it to decide whether new PRs open as drafts) | Unset: unknown, and no hint is given |
| `ci.required_checks` | The exact check names that must complete on the converged head before the drive certifies it (and, with a hold, that must run again after the hold is removed). `[]` means none: the drive relies on the overall CI verdict alone, which is green even when no CI has registered on the head. Without a hold, the drive judges each required check as branch protection does: a skipped or neutral result passes, and a legacy commit status of that name can stand in for a check run. With a hold, required checks must be check runs, since only a run's id proves it ran after the hold was removed. Unrelated to `review.required_checks`, which names the review skill's reviewer checks | Derived: the checks the pull request's base branch requires, from classic branch protection and active rulesets together. For a stacked layer, whose base is a feature branch, the checks of the branch the stack's bottom layer targets are added to the base's own. A check that protection pins to a GitHub App counts only when that app publishes it, as a check run or a commit status; a check pinned to several apps (classic protection to one, a ruleset to another) needs a passing result from each. When the base requires none, the drive also waits until some non-reviewer CI has registered on the head; where a reviewer is expected, a commit status named like the reviewer's check does not count. A base branch, integration branch, stack or protection that cannot be read is an error that asks for this field; the drive never falls back to another branch's protection |
| `ci.hold_label` | A label the repository's workflows honour on intermediate pushes: while it is present they skip their expensive jobs, and removing it runs them in full (see [§ CI hold](#ci-hold)). Requires `ci.required_checks`, listing only checks that run again when the label is removed | Unset: no hold. Every push runs the repository's normal CI and the drive never adds or removes a label |
| `pull_requests.mark_ready` | When the drive marks a draft Ready: a round number N (after round N completes), `converged` (only when the draft-reviewing reviewer has nothing left), or `never`. A draft that converges before round N is marked at convergence | `1`: after the first completed round |
| `drive.max_rounds` | Whole number ≥ 1: how many rounds a drive runs before it stops unconverged (exit `6`). `--max-rounds N` overrides it for one run; a malformed value stops the drive with exit `1` unless the flag names the budget | `10` |
| `drive.pass_deadline_retries` | Whole number ≥ 0: how many passes killed at their deadline one drive restarts from before it stops with exit `15` ([restarts](#a-stopped-drive-restarts-itself)); a malformed value stops the drive with exit `1` | `2` |
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
`gates.command` (the complete local checks) and, when set, `review.bots`
(reviewer identities). `review.job_pattern` and `review.required_checks` govern only the
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
not make a reviewer expected; it only names the repository's reviewer logins. A repository that has an AI reviewer says so in its
configuration, or the drive converges without it.

**What the drive requires of an expected AI reviewer.** Having the review skill
configured is not enough to drive. Once a reviewer is expected, the drive
certifies convergence from one posting reviewer that provides all of these:

- a check run whose name matches `review.reviewer_check_pattern`, from
  `review.reviewer_app` when one is set;
- a sticky summary comment carrying `review.sticky_marker`;
- in that comment, the commit it reviewed, stamped with
  `review.reviewed_sha_marker`.

A reviewer that skips a push may say so in that comment, in a notice marked
with `review.skip_notice_marker` that names the skipped commit. Without one,
a head it skipped reads as a head it has not reviewed yet, and the drive
waits for it (`STALE_REVIEW`) until `--timeout`.

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
| `DRIVE_PR_STATE_DIR` | State root: the drive's database `<root>/state.sqlite`, and each clone's directory `<root>/<clone-key>/` (an inherited resolved clone directory is also accepted) | Root: `~/.local/state/jig/drive-pr/` |
| `JIG_VERIFICATION_FIT_LOG` | Where `verification-fit.ts` appends its verdicts | `~/.local/state/jig/verification-fit.jsonl` |

The listing opens the drive's database, which creates and migrates it. A reader that is not a driver, such as `jig ask`, runs the sibling script `drives-read-only.ts` instead: it lists a database that is already current, lists nothing where none exists, and exits `4` with the reason on stderr, writing nothing, for one a driver's next run must first bring forward.

`drives.ts` identifies each drive's repository in both human listings and
JSON rows (`repository`): the owner/repository of the drive's remote
(`repository.remote`), or the clone's Git common directory when that remote is
unavailable or its URL yields no plain owner/repository pair. The remote's URL
itself is never printed, so a credential
in it stays out of listings. This label is read locally and does not contact
the hosting service. State, logs and leases for the same PR
number in different clones stay in separate clone directories.

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
   on an unheld pull request runs real CI. Where labels change often, as
   under the dispatcher's labels, the workflow can answer another label's
   event with a mirror run instead, which skips the heavy jobs, cancels
   nothing, and has the required check repeat the newest real run's result
   ([M13's mappings](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/mappings.md#hold)).
   And fail, rather than skip, a
   required check while the label is present, from the run the label's
   application starts onward, with a message naming the label, so a held
   head is visibly not mergeable throughout. A step in the required job
   itself may cancel its own run instead, failing only when the
   cancellation does not happen (never in a job the required one needs,
   where a cancelled run can leave the required job skipped): that
   blocks the merge too, and the released head then lists its held run as
   cancelled rather than as a red failure
   ([M13's mappings](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/mappings.md#hold)). M13's
   [workflow-convention lint](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/reference/workflow-conventions/README.md#ci-hold)
   checks all three.

The drive then adds the label before its first intermediate push, once the
PR-open run of every required check has completed, and records the GitHub
timeline event that added it. At convergence it removes the label only if
that event is still the newest transition of the label, and certifies the
head only on required checks that started after the removal. The label is a
CI cost setting, not a way to steer the drive: a label the drive has no
record of, because an earlier run lost track of it, a drive that died left
it, or someone else added it, is adopted and removed at convergence like its
own. To stop a running drive, run
`bun "<skill-dir>/scripts/drives.ts" --stop <PR> --reason "maintenance"`.
The dispatcher's `jig:hold` label prevents new launches and re-arms.

With ledger mirroring enabled, stopping requires a readable running ledger owned
by the exact target acquisition and a writer that supports verified stop
publication. The command publishes the person's stop and verifies it on the pull
request before signalling. Publication failure sends no signal. An unpublished
startup or older mirrored writer is refused. Retry once startup publishes. For
an older writer, hold dispatch before stopping that process, then re-arm with
the current plugin and release the hold. The driver
attempts its initial running ledger immediately after seeding durable state.

The operator marker holds dispatch even while the driver is still recorded
running. All local ledger writers serialize payload construction and publication,
so an older in-flight payload finishes before the marker is published; later
writes retain it. Stop-bearing ledgers use wire version 2, which older readers
refuse; ordinary ledgers remain version 1. The optional `--reason` records the
person's reason. A mailbox `stop`, a mailbox `pause` that times out, or `jig send`
with `stop` keeps its existing operator-stop exit. The dispatcher leaves these
stopped until a person re-arms them. Its hold label prevents new launches while
it remains on the pull request.

A drive recorded as stopped with no exit and no person’s-stop marker is read
as an accident and re-armed from its durable state, up to
3 attempts per pull request in a rolling hour, across accounts and hosts whose
launch claims can be read. Completing a round does not reset this count.
After the budget is spent, the next no-cause stop needs a person and sends one
notice with the handoff; it becomes eligible again as the attempts leave the
window. A legacy no-exit ledger receives at most one automatic attempt while
its stop facts remain unchanged, even beyond the hour. After hard termination,
dispatch can reconcile a local running ledger when persistent observations
prove the driver and its observed and registered pass work gone, including a
hand-armed drive with no launch wrapper. It records a no-cause stop before
applying this recovery budget. Surviving, foreign, unreadable or incomplete
evidence keeps recovery conservative: dispatch notifies once and includes the
silent drive in the waiting list. Sampling discards confirmed-dead process
identities and empty groups, while unreadable or timezone-shifted creation
times continue to withhold recovery.

When someone else removes the CI hold label, the
drive accepts only checks that started strictly after that removal; GitHub
records the removal to the second, so a run that started in the same second
has to be rerun. A pull request that conflicts with its base runs no
`pull_request` CI at all, so when the hold is not yet taken, its checks have
not completed and GitHub reports the conflict, the drive pushes the
conflict resolution without the label, and the push that clears the conflict
runs full CI. A mergeability GitHub has not computed or the drive cannot
read keeps the wait. A drive that dies mid-round leaves the label
behind; the next drive on the pull request adopts it. Adoption needs no
check runs and remains recorded across retries, so failed pushes retain the
adopted label. Release captures its own check-run watermark before removal.
The
[§ The exit states](#the-exit-states--what-you-do-now) has the recovery
when no drive will run again.

### Push hold

`guarded-push.ts` refuses to push while an orchestrator has sent the PR a
`hold-push` directive (`bun "<skill-dir>/scripts/mailbox.ts" send`). A hold sent while the push's own
pre-push hooks are already running lands after that check, so a repository
that wants those holds honoured too runs `push-hold-recheck.ts` as its last
pre-push hook command. `guarded-push.ts` arms it by exporting
`DRIVE_PR_HOLD_RECHECK_PR`. This hook starts Bun on every push; when that
variable is unset, the script exits successfully before reading the mailbox:

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
| `DRIVE_PR_CI_INFRA_RERUNS` | Integer from 0 through 100; otherwise the default. Re-runs, per head, of final checks that all failed on the infrastructure, before the head is moved instead | `2` |
| `DRIVE_PR_CI_INFRA_HEAD_MOVES` | Integer from 0 through 100; otherwise the default. Head moves (a base merge, or an empty commit) per drive to run such checks again, before the drive stops with exit `23` | `2` |
| `DRIVE_PR_CONFLICT_REPAIR_ROUNDS` | Conflict-resolution passes when the PR conflicts with its base and nothing else is left (`0`: stop at once) | `1` |
| `DRIVE_PR_FINAL_CI_WITNESS_POLLS` | How long to wait for the required checks to report on the final commit, in 10-second polls (`0`: wait forever) | `180` (30 minutes) |
| `DRIVE_PR_STALL_ROUNDS` | Consecutive rounds that change nothing before the drive stops with exit `14` (`0`: off) | `2` |
| `DRIVE_PR_PASS_TIMEOUT` | One round's agent pass, in seconds; also `bun "<skill-dir>/scripts/drive.ts" --pass-timeout` (`0`: off) | `5400` (90 minutes) |
| `DRIVE_PR_ARM_CONFIRM_SEC` | How long `arm-drive.ts` waits for a drive it started in a terminal tab to be listed | `45` |
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
`bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count 'refs/remotes/<remote>/<head-branch>..HEAD'` for unpushed commits
(`<remote>` is `repository.remote`, else `origin`; `<head-branch>` is the
PR's head branch, which a detached tree has no upstream for), and finish or
discard
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
started outside the harness: a terminal tab, which `do_item.arm_drive: auto`
opens in Orca, or a terminal or terminal-multiplexer pane of its own. Run the same `bun` command there, redirecting output to a file if
needed, and stop it with `bun "<skill-dir>/scripts/drives.ts" --stop <PR>`.
The stop command checks the driver's identity and cancels its active pass
before releasing locks.

Both variables are read when a session starts, so a drive already running
keeps its old limit, and a harness other than Claude Code has its own. Claude
Code needs version 2.1.285 or later for them to take effect.

When a summary finding stays unaddressed and its hold has no push stamp,
`drive-status.ts` reports it separately in `work.summaryHeldUndispatchedKeys`
and names the recovery: verify the promised fix, re-hold it, push and finish
the round to post its answer. This reports missing dispatch evidence; it does
not infer whether the code has already been fixed.

## When to reach for it

- **A PR exists and you want the review loop run to completion** → this skill. Normally you don't even start it by hand: a `/jig:do-item` run arms the drive when it opens the draft PR. Typing `/jig:drive-pr [PR]` in a session does the same thing: the agent starts the driver below (in a terminal tab of its own in Orca, in the background elsewhere; see [Arming from a session](#arming-from-a-session)), reports its log path, and stops — it does not work a round itself.
- **You want exactly one round, interactively, with yourself in the loop** → `/jig:drive-pr --interactive [PR]` (one in-session round, then stop), or [`/jig:resolve-review-comments`](../resolve-review-comments/README.md) (the drive wraps it).
- **CI is red and that's the only problem** → repair it directly, with [`/jig:fix-ci`](../fix-ci/SKILL.md). (A drive already in flight repairs red CI itself, up to `DRIVE_PR_CI_REPAIR_ROUNDS` times; repair by hand when there is no drive running, or when its budget is spent.)

## How to start it

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"
```

The `bun` prefix and the single line are deliberate: every TypeScript command explicitly names its runtime. On Windows, run it in PowerShell after installing Git for Windows. It is the command `/jig:do-item` and `/jig:drive-pr` start when they arm the drive for you, with the pass model and any `drive.pass_args` written in (`claude --model <model> <words> -p …`). The agent tells "a session asking for a drive" from "a pass the driver spawned" by `$DRIVE_PR_TARGET`, which only `drive.ts` sets — so a driver's own passes never arm another driver.

That pass command is Claude Code's. Codex's is the other one the drive documents, and the one a Codex session arms:

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --bots-only -- codex exec "Use the jig:drive-pr skill: /jig:drive-pr --bots-only <PR>"
```

Codex runs a plugin skill the prompt names, so the prompt names it before the same invocation. The command above is what a hand-typed start looks like: `drive.ts` runs it as written, and only `arm-drive.ts`, which `/jig:do-item` and `/jig:drive-pr` call, reads `drive.codex_bypass` into the pass command. A round pushes, calls the forge and writes the working tree's git directory, which Codex's sandbox refuses, and nobody is there to approve, so a host opts in once it has checked what its account can reach: with `drive.codex_bypass: true` in its [user file](../../CONFIGURATION.md#a-hosts-opt-in-to-bypass), an arm writes `--dangerously-bypass-approvals-and-sandbox` after `exec`, and the pass runs without a sandbox and without approvals. Without it Codex's own configuration decides and the driver log says `inherited`. The `review-arbiter` agent stays Claude Code's: a Codex pass uses the substitute in the [Codex notes](../../README.md#codex-notes). The turn-budget hook counts Codex responses and warns near its configured budget, but imposes no runtime turn cap. A Codex pass has no turn cap of its own, and the pass deadline (`DRIVE_PR_PASS_TIMEOUT`, `--pass-timeout`, 90 minutes by default) is what ends one that runs on; with the deadline switched off (`0`) nothing does, so keep it on for a Codex drive.

**The pass model.** Each round's agent runs on `sonnet`, Claude Code's alias for the latest Sonnet, unless `drive.pass_model` in the [configuration](../../CONFIGURATION.md#drive) names another model, an alias, or a complexity tier (`simple`, `standard`, `complex`; `execution` and `strategic` read as `standard` and `complex`), which resolves through the same tier-to-model table as do-item's implementer (`routing.models`). `--pass-model <model>` overrides both for one run, and replaces a `--model` the pass command carries; without it, a `--model` in the pass command is kept. The driver log's `pass model:` line and `drives.ts` name the model. A Codex pass runs on its own `-m`, else the standard tier of `routing.models.codex` (by default `terra`, written after `exec` as `gpt-5.6-terra`); `drive.pass_model` remains Claude Code's. `--pass-model` overrides either vendor, with Codex tiers resolved through `routing.models.codex`. Any other pass command chooses its own model.

**The pass arguments.** A pass started without a terminal has no one to answer Claude Code's permission prompts, so whatever would ask is denied, every write under a protected path such as `.claude/skills/**` among them in a prompting mode (`auto` lets a classifier approve some). `drive.pass_args`, a list of words such as `[--permission-mode, bypassPermissions]`, adds extra arguments to the pass command before `-p`. It is the host's to set, in its [user file](../../CONFIGURATION.md#a-hosts-opt-in-to-bypass) or one run's environment, and empty unless it does. `bypassPermissions` means a pass can do anything the host's account can (explicit ask rules, tools that need a person and checks before removing critical paths still apply), with only the instructions the drive gives it (`guarded-push.ts`, the bots-only rule) to steer it, which nothing stops it from ignoring unless that account's own settings add Claude Code `permissions.deny` rules or hooks; so a host opts in after checking what the account reaches. A repository's file that sets the field, an empty list included, stops the drive with an error naming it, since a drive reads that file from the pull request's own checkout. A list that ends in an option left without its value, such as `--permission-mode`, stops the drive too. `--pass-args "<words>"` overrides it for one run (one value, split on spaces; empty for none). `drive.ts` adds the setting only to a pass command with no arguments of its own, so a re-arm or takeover command a stopped drive printed runs the arguments it shows. The driver log's `pass args:` and `permission mode:` lines and `drives.ts` name the [permission mode](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) each pass runs in. A pass command that is not Claude Code's ignores the setting and the log says so.

### Arming from a session

`/jig:do-item` and `/jig:drive-pr` arm the drive through one script, run in the tree the drive drives:

```bash
bun --cwd "<tree>" "<skill-dir>/scripts/arm-drive.ts" <PR>
```

It builds the command above for that tree and prints it with what to do next, as JSON. `do_item.arm_drive` in the [configuration](../../CONFIGURATION.md#do_item) says how the drive starts:

| Value | The drive starts |
|-------|------------------|
| `auto` (default) | In a terminal tab of the pull request's workspace, titled `drive #<PR>`, where the session can open one (an [Orca](https://www.onorca.dev) workspace on a macOS or Linux host); with the session's background execution elsewhere, and, saying why, where Orca refuses the tab or the tab's drive is not listed in time |
| `tab` | In a terminal tab, or the arm reports why it could not open one or did not see its drive |
| `background` | With the session's background execution, as below |
| `print` | Nowhere: the command is printed for a person to run |

A tab outlives the session and shows the passes as they run, and the session that armed it ends without a drive running beside it. Once the drive ends with nothing for a person (converged, merged or closed, taken over, re-armable, stopped or paused by a person, or refused because another driver holds the pull request) the tab closes itself; a park or a failure keeps it open for you, and arming the pull request again closes that earlier tab if nothing is running in it. What the tab showed stays in the driver log, the ledger and the pass's session transcript. It is a fresh login shell of yours: `bun`, the agent's command (`claude` or `codex`) and the account or profile the drive uses come from that shell, not from the session. The script waits for `drives.ts` to list the new drive (`DRIVE_PR_ARM_CONFIRM_SEC`, 45 seconds by default), and opens no tab while a drive already holds the pull request; under `auto`, a drive it does not see in time is started in the background instead, and one the tab did start meets the second on its lock (exit `11`). A Windows host opens no tab, since Orca's tab there can run `cmd.exe` or PowerShell and the command is quoted for a POSIX shell. `--mode` overrides the setting for one arm, `--pass-model` the pass model and `--pass-args` the extra pass arguments (both forwarded to `drive.ts`, so the driver log names them), and `--max-rounds`, `--keep-draft` and `--handoff-at` pass through to `drive.ts`. A failure answers with the same JSON, `status: failed` and its `reason`. The command is the pass command of the agent tool the session runs in: a Codex session arms Codex's, in a tab where it can open one and otherwise through its managed command tool (`exec_command`, then `write_stdin` with the returned session handle). If the host exposes no managed background tool, print the command and report the limitation. Keep the session alive while the driver runs if the host terminates children on session exit; use a terminal tab for a drive that must outlive it. `--pass-model` works for either vendor; `--pass-args` remains Claude Code's and is refused for Codex. A session of any other tool, or a human checkpoint the run has no clearance for, gets the command only.

### Which working tree drives it

Any working tree of the clone can drive a PR. Once it holds the tree's
driver lock and the PR's, `drive.ts` **attaches** the PR to
the tree it runs in (`<skill-dir>/scripts/attach-pr.ts`): it checks that
the drive's remote (`repository.remote`, else `origin`) is the PR's
repository, fetches the PR's head branch from it, checks
the branch out when no other working tree of the clone holds it, and checks
out the PR's head commit **detached** when one does, since git allows one
checkout per branch. It never creates a second, suffixed branch: the drive
pushes to the PR's head branch by name from whatever commit the tree is on,
so a detached tree pushes exactly as a named one does. A detached tree keeps
a record of its PR, head branch and attached commit in its own git
directory, and every later step reads the branch from that record for as
long as the tree's head descends from that commit and the branch is still on
the remote; an attach by name removes it. The drive state's `drivenBranch`
mirrors it for the handoff file.

It refuses, naming what is in the way, when this tree has uncommitted changes
or an unfinished merge, rebase or cherry-pick and the attach would move it (a
tree at or past the head is not moved when it is on the head branch, or
detached under this PR's record with the branch held elsewhere or commits of
its own, and what it holds uncommitted is the drive's to handle); when the tree holding the
branch has uncommitted changes or commits the PR's head does not have
(push them from there first); when this tree's detached head has commits no
branch or remote holds; when a local branch of that name is ahead of the
head and this tree would switch to it (a tree already on the branch keeps
its commits ahead of the head, and the drive pushes them); when this is the clone's primary checkout on another branch; when
the drive's remote is another repository; and when the PR comes from a fork, whose head
the drive cannot push to. It moves nothing while a live driver holds the tree
or the PR, or an interactive session holds the tree, unless it runs in a pass
of the driver that holds both: under the environment its driver hands it, a
pass attaches as the driver's own attach does, and `--place` tells it it is a
pass rather than arming another drive (exit `4`). A dry run attaches
nothing, and `DRIVE_PR_ATTACH=off` drives the tree as it stands, for a
harness that prepares its own trees: placement (below) still chooses the
tree, and attaches nothing.

`/jig:drive-pr <PR>` decides the tree before it arms the driver
(`bun "<skill-dir>/scripts/attach-pr.ts" <PR> --place`): the session's own working tree, or, from the
clone's primary checkout, the tree that already holds the PR, else a new one
created with git's `worktree add --detach` under the first root
`gc.worktree_roots` names, once the drive's remote is confirmed as the PR's
repository.
A tree it creates is recorded as the PR's at once, so an attach there that
fails or is interrupted is retried in the same tree. [Resource collection](../../gc/README.md)'s
`worktrees` kind reads a detached tree's record to find its PR, and reports
the tree once that PR merges or closes, as it reports a branch's tree. A PR
in another repository can be named as `owner/name#N` or by its URL: the
drive is armed in that repository's clone named by the `clones` map in your
user file (`~/.jig/jig.yaml`,
[configuration](../../CONFIGURATION.md#clones-user-file-only)), and with
none mapped the session prints the command to run in a checkout of it. The
human checkpoint the arm checks is read in the placed tree, so another
repository's PR is checked against that repository's tracker. The
`gc.worktree_roots` a new tree is created under, the attach, the checkpoint
and the driver are all read or run without the variables that would
select something else than the placed tree: `GH_REPO` always; a running
drive's own `DRIVE_PR_WORKTREE` and session when they name another tree;
in any tree other than the session's own, the location overrides
`JIG_CONSUMER_ROOT`, `JIG_OVERLAY`, `DRIVE_PR_HANDOFF_DIR`,
`DRIVE_PR_MAILBOX_DIR` and `DRIVE_PR_INTENT_CHAIN_DIR`; and, in another
clone, a driver's exported state directory. Placing another clone's PR from inside a drive
whose state is under a relocated `DRIVE_PR_STATE_DIR` is refused (exit 2):
arm it from a session outside the drive.

`--bots-only` keeps it off human-authored threads (recommended for unattended runs). `--keep-draft` stops it marking the PR Ready (`pull_requests.mark_ready: never` does the same for every drive). `--max-rounds N` bounds the loop (default `drive.max_rounds`, else 10). `--dry-run` reports what each round would do and never invokes the pass. `--take-over` and `--window-reopened` pick a stopped drive up ([below](#picking-up-a-stopped-drive)). Starting it twice **in the same clone** is safe — see exit `11`. The lock lives in the drive's database, keyed by this clone, so it covers this clone and its linked worktrees and nothing further. Another clone — another machine, a CI checkout — is held off by the [drive ledger](#where-its-state-lives) instead: while the ledger names a running driver in another clone, an arm is refused with exit `13`.

`--settle-worktree` asks for a pass to settle an exit-12 stop in the tree
that holds its leftovers, even if review has already converged. The pass
inspects the edits, validates and commits work belonging to the change,
discards only work it establishes as unrelated, and pushes through the
guarded push. The normal clean-tree and exact-head checks then run again;
a successful pass that leaves edits behind still exits 12.

### A stopped drive restarts itself

Some stops need no decision, and the drive recovers from them without you.
A pass killed at its deadline is not rolled back: the drive runs the two
checks it used to leave to you (uncommitted edits, and commits the head
branch's remote ref lacks), prints what it finds, leaves it in the tree and
starts the next round, whose pass is told what it inherits. A commit the
killed pass made but did not push does not hold that round up: the drive
records the head it left, hands the round out over exactly that head, and
the next pass pushes it. Uncommitted edits alone are not mistaken for
convergence either: the drive hands that round out before it can converge.
The drive restarts up
to `drive.pass_deadline_retries` times per drive (default 2; the count is
kept in the drive state, so a re-arm or a takeover does not reset it, and it
clears when the drive converges or the PR closes; a clear that fails ends
the drive with exit `1` and prints the command that clears it) and then stops
with exit `15`, saying the budget is spent. A stall gets one more round with
the stall's diagnostics and what the tree holds in the pass's notice before
the drive stops with exit `14`, and the stop prints what that round's pass
recorded: the refusal that stops the round now. A short usage
limit is slept through, as before.

The driver disables Claude Code's background tasks in its spawned passes
with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. A successful pass that leaves
uncommitted edits and this tree's unverified holds from the current round
stops immediately with `WORKTREE_UNCLEAN` (exit `12`), naming the unfinished
held fixes. Validate, commit and push them, then re-arm in that tree. Other
runtimes follow the same foreground completion rule.

The same holds for other work nobody pushed: a pass that ended its turn after
committing or after editing and still exited `0`, or a drive armed over
local commits. Before every round's status check the
drive measures the tree afresh, counting the commits local HEAD has that the
head branch's remote ref lacks and the edits the last pass left uncommitted,
and hands the round out over that head, telling its pass to push them,
rather than waiting for GitHub to report a push that never happened or
converging over edits no pass committed. Once a measurement finds neither, a
push GitHub has not caught up with is waited for as before, and so is one
whose pushed state cannot be read on the drive's remote. Edits are compared by
content, so a pass that edits a file already shown as modified has left work.
Edits the tree already held at arm, or that a pass was handed and left as
they were, still stop a converged drive with exit `12`. When those commits do not build on
the remote ref (history was rewritten), no round could push them, so the
drive stops at once with exit `1` and names them; a drive armed over such a
tree is refused by the [attach](#which-working-tree-drives-it) with exit
`2`, which names them too, or, with the attach skipped
(`DRIVE_PR_ATTACH=off`, `--dry-run`), stopped with exit `1` at its first
status check. A pass that fails stops the drive rather than handing its work
to a round, and the stop lists what it left uncommitted and unpushed: keep or
discard that work, then re-arm.

### Picking up a stopped drive

A drive that stopped holds no lock, except one that stopped with exit `15`
on a kill it could not witness, which keeps its locks until what the pass
started is gone. So you pick a stopped drive up by running the arm command
again, from any session of the clone. These stops let it through on a
mechanical state rather than on anyone's judgement:

- **Quota-parked (exit `16`).** The stop names the account the limit belongs
  to and prints the command. While the limit is in effect, a re-arm whose
  pass bills **another** account is admitted, and one on the same account, or
  on an account that cannot be resolved, is refused with exit `16`. A pass
  authenticated by a token or an API key counts as unresolved: its
  fingerprint names a credential, not the account behind it. After the
  reset any account may re-arm; if the reset time was never known and you
  know the limit has lifted, add `--window-reopened`. Only a person passes it:
  the skill forbids an agent to, as it does for `clear-lease`.
- **HITL-parked (exit `8`).** Only decisions the repository's
  human-in-the-loop registry reserves are parked, each under its class, and
  the stop prints each in full: the question, the options with what each
  changes and costs, the recommendation, the steps you must take and what the
  drive already did. The doctor names the questions in its `NEEDS_HUMAN`
  row. Each question names the area owner, else `dispatch.person`, else the
  pull request's author; this routes the question without restricting answers.
  Non-login owners are ignored, and login identity is case insensitive.
  Null recipient settings are unset; an invalid or unreadable catalog is
  reported and uses the fallback.
  Answer each parked item on its thread, or in a
  pull-request comment with a line `answer <key>: …`, as an owner, member or
  collaborator; `jig send drive@<owner>/<name>#<PR> answer <key> "<text>"`
  writes that comment after checking the key is parked, and
  `answer <key> --approve` or `--choose "<option>"` writes a structured
  answer bound to the digest you read
  ([the plugin's README](../../README.md#telling-a-station-what-to-do)).
  Use `approve` to choose the recommendation or `choose <option name>` to
  choose an option by name. On a thread, either form can be the whole reply.
  Beside an answer, `note <key>: <text>` adds a condition of at most 500
  characters. Other prose or code makes the comment a free answer, which
  the pass interprets. An unknown option also stays free; `jig ask` labels
  it that way. Phone typography, case and Markdown emphasis do not affect
  matching. A note alone does not answer the question.
  Copy the notification's answer line with its
  [decision digest](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  for example `answer <key>: approve [3fa9c2d1e0b4]`. The digest identifies
  the framing you read. If it has changed, your answer stays stale even if
  you posted it after the new park; the next notification explains why.
  A re-arm also waits when local state and the published ledger hold
  different framings. A line without a digest, or a park made before
  digests, stays bound by time alone.
  Each person's latest answer counts, using the comment's last edit time
  when edited. If everyone chooses the same option with the same note, it
  is answered. If everyone's answer is free, the pass interprets them all.
  Different choices, different notes, or a
  [structured answer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) beside another
  person's free answer leave the question disputed and waiting. The
  dispatcher notifies you of the dispute.
  Once every item is answered, the re-arm unparks them all, leaves in the
  drive ledger a resolution receipt for each (which answers it consumed, and
  when), from which the dispatcher's outcome log counts the park as
  answered, and hands your answers to the drive's passes as your verdicts, keeping them in
  the drive's state directory until a pass completes, so a drive that stops
  first still hands them on when it is re-armed. A structured verdict keeps
  the chosen option, its decision and your note. The pass applies the option
  with the note's conditions; a note cannot grant broader permission. If
  those conflict, the pass parks the question again and quotes the note.
  With any item unanswered
  nothing is unparked. If the pull request conflicts with its base, the
  re-arm attempts conflict repair within its budget. Successful repair lets
  the next gate park on unanswered questions; a remaining conflict stops
  `9` (`PR_CONFLICTING`), including when repair fails, is disabled or has
  spent its budget, or the base cannot be read. Otherwise the drive stops `8` again; at the `wide` level,
  except where every unanswered item has no person's answer and the class
  `escalated`, which the re-arm hands to the first round to decide provisionally.

A driver that still holds its locks but is stuck can be **taken over**:

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --take-over --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"
```

The takeover reads the holder's verdict from `bun "<skill-dir>/scripts/drives.ts" --doctor` and is
admitted only when the holder is `WEDGED` (alive, no progress past the stall
threshold, no pass running), or when its process is confirmed gone and its tree holds
nothing unpushed (on this machine it refuses, naming the leftovers, until you
push or discard them). A tree that no longer exists, because its directory was
deleted, has no working files to inspect: the doctor reads that holder `DEAD`,
and the takeover goes ahead with nobody needed, recording the tree and telling
the first pass to inspect branch refs and [reflogs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) in the clone's shared Git storage for
recoverable commits before redoing work. An existing tree that is unregistered or cannot be
inspected still refuses. Against any other holder it refuses as exit `11` does.
It stops a wedged holder with the same identity check that `--stop`
makes, and only the driver whose verdict it read: one that took the lock
since is left running. It records the takeover in the drive state, reconciles
the threads that already carry a reply, and resumes at the same round. A held
thread whose promised fix is not verified as pushed is held again as
unconfirmed, the way reconciliation holds a reply it finds, so it is not
resolved until the new driver confirms the fix is in the tree or replies
afresh; nothing is posted on the thread. A hold that could not be reopened is
recorded and reported apart. The checks that need no lock (the pass
command, the quota re-arm, the held batch) and this tree's own lock run before
the holder is stopped. Attaching the tree and taking the PR lock can only run
after it, and can still refuse (a dirty tree, an unfinished git operation, a
fork, another repository); such a refusal says the holder was stopped and
prints the plain re-arm command. Do not stop a driver that is making
progress.

A driver in **another clone** cannot be stopped from here, so the takeover
goes through the drive ledger on the pull request. When no driver of this
clone holds the drive and the ledger names a running driver elsewhere,
`--take-over` is admitted only when that ledger's heartbeat (its last write)
is older than the lease window, the doctor's stall threshold (four hours by
default); a plain arm is refused with exit `13`, and the refusal prints the
`--take-over` command once the heartbeat is past the window. The taker posts a
takeover claim on the pull request; so does any drive that does not continue
its own clone's ledger, such as the first drive of a pull request. If two
clones claim at once, the earlier comment wins and the later one stands down
with exit `20`. A claim the pull request's comments still do not show after a
few reads refuses the drive with exit `1`, since it cannot tell a won claim
from a lost one. A claim whose clone never got the drive going stops counting
after the lease window, and a retry from that clone picks up its own claim.
The old driver, if it is still alive, reads the claim at its next round
boundary or before its next pass and stops with exit `20`. A drive that
cannot read the pull request's comments when it starts refuses with exit `1`
rather than risk driving beside another clone. This holds only once every
driver of the pull request runs a version of the plugin that reads the
ledger.

### The morning report

After a night of unattended drives, one command says what happened:

```bash
bun "<skill-dir>/scripts/drives.ts" --report
```

It covers every pull request this clone's state has news of, and every open
one your account authored or drove, found through the drive ledger, since
the last full report (remembered in the state directory only by a report
with no `--since` that read everything; the last day for a first
one) or `--since <time>` (a time such as `2026-10-29T06:00Z`, or a span such as `12h`). For
each it gives the terminal state and what it means for you, the provisional
decisions first (and whether someone reversed them), the takeovers and
re-arms, the parked decisions in full, the issues filed and the deferred
findings not yet filed, with the `file-deferred.ts` command that files them.
A local process identity matching the ledger's actor and start time that
has exited overrides its fresh `running` heartbeat. Foreign or uncorrelated
drivers still use the heartbeat window; their local liveness is not known.
Where the [dispatcher](../../README.md#the-dispatcher) runs on the machine,
it then lists what the dispatcher did over the same time, from its tick
receipts: the sessions it launched, the launches it refused, and the
notifications it sent (a refusal repeated tick after tick is listed once),
and, for a repository that turns
[pull request state labels](../../CONFIGURATION.md#dispatch) on, how many pull
requests its latest run projected each label for (the labels it wanted,
not read back after its writes). It also lists the workspaces the
dispatcher launched into, found by the dispatched mark on their launch
records rather than by their names and listed by the night the launch was
recorded, each with the name it carries now, whether its comment still
carries the mark, and how its launch went when it did not start, so a
workspace a session renamed is still there. Last come the plugin upgrades
the machine's timers ran over the same time, from the jobs' receipts: each
that moved the plugin (`0.114.0 -> 0.115.0`) and each that failed, with the
agent tool's error ([automatic updates](../../README.md#automatic-updates)).
`--json` prints the same as data, the dispatcher's part under `dispatch`,
the label counts under `dispatchLabels`, the workspaces under
`dispatchedWorkspaces` and the upgrades under `upgrades`.

On a machine whose timers keep the plugin current, a drive's rounds may
span plugin versions: the driver keeps running the copy it started with,
which stays in its own versioned directory, and each pass starts with the
copy installed at that moment.

Where your repository has a pre-merge follow-up step, have its list include
the pull request's provisional decisions, so the person merging reads each
one, and whether it stands, before the merge. The morning report lists them
under `provisional` when run with `--since` set to when the pull request
opened, and `--json`:

```bash
bun "<skill-dir>/scripts/drives.ts" --report --since <opened-at> --json
```

## The exit states — what you do now

| Exit | State | What you do |
|------|-------|-------------|
| `0` | **`CONVERGED`** | The exact head is reviewer-clean, the worktree is clean, the CI hold label (if the repository has one) is absent, and full non-reviewer CI is green with a fresh exact-head witness from the required checks. The merge decision is yours. **One caveat that is not optional:** if this drive marked the PR Ready, convergence is against the draft-reviewing AI reviewer **only** — marking Ready is what summons the reviewers that skip drafts, so anything they post lands *after* the drive ends. The drive says so on stderr; re-run it once they settle. `drive.ts` does **not** post the merge-ready announcement itself. Run `bun "<skill-dir>/scripts/workspace-pr-link.ts" <PR>` first, from the worktree that drove the PR (skip it from any other), so the Orca workspace points at the PR; then run `bun "<skill-dir>/scripts/announce-merge-ready.ts" <PR>` if you want one on the PR. It re-checks convergence, non-reviewer CI, the absent hold, and a clean worktree before posting, and asks the Ready predicate the dispatcher shares: it posts only when the forge witnesses a review of the head and lets it merge, or says an approval is still required. `--dry-run` never invokes a pass, so a `0` from it is either this same convergence (the gate reached it first) or simply the command it *would* have run — the printed output says which. |
| `5` | **PR not open** (`PR_NOT_OPEN`) | The PR merged or closed while driving. Usually nothing to do — but if it happened *mid-round*, `guarded-push.ts` refused the push and **this round's commits are still local**, deliberately, so the work stays visible instead of landing on an orphaned branch. Check `bun "<skill-dir>/../../shared/command.ts" -- git log '<remote>/<branch>..HEAD'` (`<remote>` is `repository.remote`, else `origin`) and either port those commits somewhere that will merge or discard them on purpose. |
| `8` | **HITL-parked** (`HITL_PARKED`) | Everything left needs a human call — each parked under a registry class with its decision framed, printed in full by the stop, after the drive worked everything else to its end. Read the stop, the round report or the `.context/pr-drive-<PR>.md` handoff, then answer each parked item on its thread or in a PR comment with a line `answer <key>: …`. Once every one is answered, re-run the command the stop prints: the re-arm unparks them and hands your answers to its passes until one completes ([picking up](#picking-up-a-stopped-drive)). It does not wake itself up. Under `jig dispatch` a parked pull request that comes to conflict with its base is re-driven, once for each pair of its head and its base branch's head: the re-arm's first gate reports the conflict before the park, the drive attempts to merge the base, then parks on unanswered questions if repair succeeds; a remaining conflict stops `9` (`PR_CONFLICTING`) and needs resolution |
| `9` | **Conflicting, nothing to work, and the repair budget is spent** (`PR_CONFLICTING`) | Either the drive spent the conflict-repair budget (`DRIVE_PR_CONFLICT_REPAIR_ROUNDS`, default 1) trying to resolve it and could not, or no repair pass ran at all — the budget is `0`/disabled, or the PR's base ref could not be read. Either way, merge the PR's **own base** in — not necessarily the default branch, since a release or stacked PR has a different one. The drive prints the exact command (`bun "<skill-dir>/../../shared/command.ts" -- git fetch <remote>`, followed on success by `bun "<skill-dir>/../../shared/command.ts" -- git merge <remote>/<base>`, naming the remote `repository.remote` sets) rather than guessing; use that. Then resolve, run the emitted validation plan, push, re-run. (A conflicting PR gets zero `pull_request` CI until you do.) A merge the repair pass did not conclude is aborted before this stop, except a merge that was already open when the pass began, which is kept, and one whose abort failed: when the stop reports a merge left open, finish or abort it before running the printed command, which fails in an unconcluded merge. Under `jig dispatch` nothing is owed yet: the dispatcher re-drives the stop once for each pair of the pull request's head and its base branch's head, and tells you when that re-drive stops here again |
| `12` | **Worktree unclean** (`WORKTREE_UNCLEAN`) | A pass exited `0` with dirty work and this tree's unverified current-round holds, or review converged over an unclean tree. The first cause names unfinished held fixes and does not claim convergence; validate, commit and push them before re-arming in that tree. For the convergence case, something local is unshipped. The causes and their fixes: uncommitted edits → commit or discard; an unconcluded merge/cherry-pick/revert/rebase/am → resolve or abort it; a local `HEAD` no longer matching the reviewed head → push it or reset. The last two leave `git status` **clean**, so don't stop there — the drive names which probe failed, and [`terminal-states.md`](references/terminal-states.md) lists them all. Then re-run. |
| `4` | Timed out / Ready-lease held elsewhere / no fresh CI witness (`NOT_SETTLED`) | Usually a reviewer that never answered, or another worktree's driver holds the Ready-mark lease. Check the reviewer check-run on the PR; re-run, or find the other driver. A third cause: the review converged and nothing is failing, but no fresh exact-head required-check witness showed up within `DRIVE_PR_FINAL_CI_WITNESS_POLLS` (default 30 minutes) — a required check whose fresh run completed **skipped** can never resolve this by waiting, so re-run the required checks on this head (a fresh run, not `gh run rerun` of the old one) and re-arm. Cancelled workflows use their own recovery: after a 30-second grace period without an active replacement, the drive requests one re-run per head. A refused or unconfirmed request, an unsafe held event, or a cancellation still unreplaced 60 seconds after the request with no active run parks with exit `8`, naming the run and what a person must inspect. Other failed jobs in a cancelled run still count as failing. |
| `6` | Max rounds | The bound fired before convergence — often a finding the agent cannot fix, or a reviewer past its own round ceiling. Read the last round report before re-arming with a higher bound. |
| `7` | Reviewer check failed (`REVIEWER_FAILED`) | The reviewer's check-run did not pass, so a "zero threads" read would be meaningless. Look at the check on the PR. |
| `22` | `REVIEW_SKIPPED` | The reviewer skipped this head (its sticky comment's skip notice names it), and its review of an earlier head does not cover it: the pull request's diff changed, a moved or edited line or a rewritten binary file included. No review of this head will come. Review the change since the reviewed head and have the reviewer review this head, or push a commit it reviews, then re-arm. A head the reviewer skipped without changing the pull request's diff, such as a merge of the base branch, converges on the earlier review instead. This stop is yours: where the pull request state labels are on (`dispatch.labels`), the drive labels the pull request parked as it stops. |
| `10` | — | Reserved; never returned. |
| `11` | **Another driver is live** | The drive is already armed — in this worktree or another of this clone. The refusal names the holder's `--doctor` verdict. Do not stop a driver that is making progress; when the verdict is `WEDGED`, the refusal prints the `--take-over` command, and a dead holder can be taken over once its leftovers are pushed or discarded, and at once when its tree no longer exists ([picking up](#picking-up-a-stopped-drive)). A `--take-over` refused for the holder's verdict exits `11` too. |
| `13` | `DRIVE_HELD_BY_OTHER_WORKTREE` | Another live *working tree* is mutating this PR's drive state, possibly through an interactive pass rather than another driver — a case not covered by `11` when the other session is not itself holding `drive.ts`'s PR/worktree locks. Inspect with `bun "<skill-dir>/scripts/drive-state.ts" lease <PR> --all`; wait for the holder, or take over with `bun "<skill-dir>/scripts/drive-state.ts" clear-lease <PR> --all` once you have confirmed it is dead. `drive.ts` also stops with `13` at arm when the drive ledger names a running driver in **another clone**; the refusal says how old its heartbeat is, and prints the `--take-over` command once that is past the lease window ([picking up](#picking-up-a-stopped-drive)). |
| `14` | **Stalled** | `$DRIVE_PR_STALL_ROUNDS` (default 2) consecutive passes changed nothing this loop can observe — the reviewed head, local head, and every unresolved-thread/summary-finding/parked-key set, including each open thread’s latest comment, all came back identical. The usual cause is a pass exiting 0 without acting (for example, standing down against its own parent driver) while the round headers still look healthy. First check what the driven worktree still holds — the stop prints it, and a pass can make correct edits and stall before committing them. The drive already ran one extra round with the stall's diagnostics in the pass's notice before stopping, and the stop prints what that extra round's pass recorded at the end of the handoff narrative (or says the lines it prints predate that round); read that and the pass output, fix why they did not act, then re-arm the same command. Under `jig dispatch` nothing is owed yet: the dispatcher re-drives a stall once per head commit (in the same tree when the stop left work in it), and tells you when the same head stalls again. |
| `15` | **Pass deadline** | Agent passes ran longer than `DRIVE_PR_PASS_TIMEOUT` (default 90 minutes) and were killed more often than `drive.pass_deadline_retries` (default 2) lets the drive restart from; the stop says the budget is spent. A kill whose end could not be witnessed stops here at once instead, without spending the budget and **with its locks held**: something the pass started may still be running, so find and stop it before re-arming (`bun "<skill-dir>/scripts/drives.ts"` shows the holder). Nothing was rolled back: check `bun "<skill-dir>/../../shared/command.ts" -- git status --short` for an uncommitted fix and `bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count 'refs/remotes/<remote>/<head-branch>..HEAD'` for a committed but unpushed one, keep or discard that work, then re-arm. If a legitimate round needs longer, raise the deadline; if not, look for what hung. Under `jig dispatch` the dispatcher re-drives a spent budget once per head commit (in the same tree when the stop left work in it, where the re-armed drive takes those edits as its own to finish), and tells you when the same head stops `15` again; a kill it could not witness leaves the ledger running: a drive no launch started is taken over only once this host shows its driver and passes gone, and one a launch started is taken over as any silent launched drive is, subject to `drive.ts`'s admission. |
| `16` | **Quota-parked** | The agent hit a subscription usage limit that will not reset within `DRIVE_PR_QUOTA_MAX_SLEEP_SEC` (default 6 hours) — a weekly limit, or one whose reset could not be read. A short limit never reaches this exit: the drive sleeps through it. Nothing is wrong with the PR. Run the same two `git` checks as for `15`. The stop names the account the limit belongs to and prints the re-arm command: run it from a session whose pass bills another account now, or on this account once the limit has reset ([picking up](#picking-up-a-stopped-drive)). A re-arm on the same account before then is refused with exit `16`. |
| `18` | `MAILBOX_STOPPED` | A mailbox `stop` ended the drive after any active pass and its Ready transition finished, and the outbox carries the driver's `ack` of it. A stop sent with `--generation` (the driver generation the drive printed at its start) ended that driver only, so re-arm as you like; a stop without one stops every later drive in this working tree too, so send `resume --target stop` before re-arming. |
| `19` | `MAILBOX_PAUSE_TIMEOUT` | A mailbox `pause` stayed active for `$DRIVE_PR_PAUSE_MAX_SEC` (default 30 minutes). Send `resume --target pause`, then re-arm. The driver releases its locks on this exit. |
| `21` | `CI_REPAIR_SPENT` | The review converged, but full CI on the converged head still names failing checks after the CI-repair passes (`DRIVE_PR_CI_REPAIR_ROUNDS`, default 2) were spent. Repair CI with [`/jig:fix-ci`](../fix-ci/SKILL.md), or re-arm: a new drive starts with a fresh budget. The dispatcher re-drives it once per head commit, and tells a person when the same head stops `21` again. A failing check that failed on the infrastructure never spends a repair pass: see `23`. |
| `23` | `CI_INFRA_PERSISTED` | The review converged, and every failing check on the converged head failed on the infrastructure (a lost runner, or a setup step's network failure such as a tool download answering 504, with no code error in its log). The drive re-ran the failed jobs, and moved the head (merging the base, or an empty commit) where a run could not be re-run, until `DRIVE_PR_CI_INFRA_RERUNS` and `DRIVE_PR_CI_INFRA_HEAD_MOVES` were spent; no repair pass was spent. Nothing to fix in the code: re-arm once the service recovers. The dispatcher re-drives it after a backoff that doubles with each consecutive such stop, and tells a person once the stops outlast its re-drives. |
| `20` | `TAKEN_OVER` | Another clone took the drive over: its takeover claim on the pull request is newer than this driver's own, so this driver stopped at a round boundary, or during a usage-limit sleep or mailbox pause, without another pass, or this `--take-over` lost to an earlier claim. That clone drives now; nothing to do here, and do not re-arm beside it ([picking up](#picking-up-a-stopped-drive)). |
| `1` / `2` | Pass failed / usage error / **CI still red** | Operational. Read stderr; `2` usually means the command line itself is wrong, or that the [attach](#which-working-tree-drives-it) refused this tree (it names what is in the way), but can also mean `UNSUPPORTED_CLI` — a `gh` too old to report a required PR field such as draft state or mergeability. For that case, upgrade `gh`; it is not a CI-repair matter. `1` is also the CI stop when repair is disabled (`DRIVE_PR_CI_REPAIR_ROUNDS=0` stops on the first red), when a repair pass itself failed, or when the verdict was unreadable rather than a named failure; a spent repair budget is `21`. An orphaned cancelled check uses the bounded re-run and parks with `8` when it cannot recover. Repair CI by hand, then re-arm. A failed pass's stop lists what it left uncommitted and unpushed: keep or discard that work, then re-arm. `1` is also the stop over local commits that do not build on the head branch's remote ref ([restarts](#a-stopped-drive-restarts-itself)): it names them; rebase them onto the PR head, or reset to it and keep what is sound, then re-arm. Armed over such a tree, the attach stops it first with `2`, naming the same commits, unless `DRIVE_PR_ATTACH=off` or `--dry-run` skips the attach. Under `jig dispatch` a `1` on a pull request that conflicts with its base is re-driven once for each pair of its head and its base branch's head, so its conflict-resolve round runs. |

Infrastructure retry budgets accept integers from 0 through 100; invalid or
excessive values use the default. A base-sync refusal or unreadable report
stops recovery without an empty commit. A successful local base merge is
handed to the next review round, which runs the configured validation plan
before pushing it through `finish-round.ts`. Log classification keeps each
failed job tied to its workflow run and rejects unplaced negative evidence.
An empty recovery commit must retain the reviewed parent and tree; a changed
head or tree stops its direct push and needs a validated review round.

### Recovering a stranded CI hold

A stopped driver can leave the configured CI-hold label attached, so full CI
cannot start even though review is complete. A ledger that still says
`running` is not proof of a live process. Read `jig ask drive <PR>` or
`bun "<skill-dir>/scripts/drives.ts" --doctor` for the drive diagnosis;
plain `jig doctor` checks installation and configuration instead.

Direct release is appropriate only when the diagnosis establishes that the
local driver stopped, review converged on the current PR head, no human
decision remains, and the matching worktree is clean and owns the recorded
hold. The stopped-driver evidence must also establish that its round
processes ended and no newer takeover claim owns the drive. If any evidence
is unavailable, say what is missing and establish it before proceeding. A live or foreign driver is not a stranded local hold.

On an explicit request to release that CI hold, re-read the diagnosis, then
run its guarded recovery command from the worktree it names, with the
expected head and label transition it verified:

```sh
bun "<skill-dir>/scripts/ci-hold.ts" release <PR> --expect-head <SHA> --expect-transition <ID>
```

Use the authenticated forge identity for the intended repository. The
recovery command checks the expected PR head and newest label transition
before removing the label. If someone removes and re-applies the hold, the
transition id changes and recovery refuses with exit 4. Diagnose again to
review the new hold. Ordinary drive release, without `--expect-transition`,
continues to adopt a label it does not own. Relay a refusal; do not bypass
it with a raw label edit or restart the driver. The dispatcher's `release`
verb releases a dispatcher hold and has no effect on this CI hold.

Observe label removal and a fresh required-check run on that expected head.
`bun "<skill-dir>/scripts/ci-hold.ts" final-ready <PR> --expect-head <SHA>` checks the full-CI witness;
add `--require-success` when reporting CI success. An in-progress run is not
success, and review convergence alone proves neither CI started nor passed.
Do not rerun the old held workflow: its original event payload still carries
the label and can skip or fail on the hold again.

Where the repository turned on the [`changelog`](../changelog/README.md) skill
(`changelog.file` in the `.config/jig.yaml` its base branch holds), a round whose accepted fix
changes what the pull request's change note says updates the note in the same
round. A repository that did not is never asked for one.

Where the agent runs in Herdr or Orca, the workspace is renamed at the following points: when a session
arms the drive (the driving stage, `[D]` by default) and after the
merge-ready announcement (the ready stage, `[R]`). With
[`workspace_name.template`](../../CONFIGURATION.md#workspace_name) set to
`""`, or outside Herdr and Orca, nothing is renamed, and a rename that fails only warns.

Where the agent runs in Orca, the workspace is also linked to the pull request
it drove, before the merge-ready announcement: `bun "<skill-dir>/scripts/workspace-pr-link.ts" <PR>`
reads the workspace's linked pull request and sets it only when it is missing or
names another one. Run it only in the worktree that drove the pull request. Outside Orca
it does nothing, and an Orca failure only warns (exit `0`).

The drive also keeps the workspace's card on Orca's board true. When it marks
the pull request Ready, the card moves to In review with the pull request
linked. When it stops on something you must look at (a park, a usage-limit
stop, or a failure stop such as a failed reviewer check, a stall or a spent
round budget), the card is marked unread with the stop's one-line reason as
its comment, a park's question first, so Orca Mobile shows what is waiting.
While the card is still unread, the reason is appended to its comment rather
than replacing what a person has not read yet.
Convergence adds no stop update, though the Ready transition can still move the card; [`orca.board`](../../CONFIGURATION.md#orca)
maps the stages onto custom columns. Outside Orca nothing is called, and an
Orca failure only warns.

## What it will never do

- **Merge, approve, or request changes** on the PR.
- **Mark Ready before a completed round**, mark Ready under `--keep-draft`, or **re-mark a PR you converted back to draft** — the transition is once-only and defers to you.
- **Touch human-authored threads** under `--bots-only`.
- **Resolve an accepted thread before its fix's push is verified** on the remote head — a fix that failed gates is not a fix.
- **Bypass repository hooks or the emitted validation plan.** There is no `--no-verify` path.
- **Park a question outside the registry's classes.** It decides it instead, at the repository's autonomy level, and records the decision where you can reverse it: the thread reply, the decision record, the issue, the pull request's `## Deferred` section, and the drive ledger's `## Decisions taken unattended`.
- **Make a fix on a provisional decision, or decide one again.** At the `wide` level an escalation it may take is answered with a reply outcome only (`rejected`, `wont-fix` or `deferred`), marked `**provisional**`, so the diff never grows. Your comment on that thread reverses it: the next round parks it for you under `human-thread`. Unresolving the thread alone reverses nothing.
- **Answer a review bot's acknowledgement**, or take a comment it cannot classify as harmless.
- **Create a label, or label a held pull request.** Its state label (§ Where its state lives) assumes the labels exist, and leaves a pull request carrying `hold` or `held` as it is.
- **Start a second loop on the same PR** — the per-PR lock refuses one from this clone (exit `11`), and the drive ledger one from another clone while it names a running driver there (exit `13`) — see § How to start it.

## Where its state lives

- **The drive's database** — `~/.local/state/jig/drive-pr/state.sqlite` by default, one per machine (`<skill-dir>/scripts/lib/state/db.ts`, opened through the plugin's shared `shared/records/db.ts`; `$DRIVE_PR_STATE_DIR` relocates its root — § Relocating the state dir). Every row is keyed by the clone it belongs to, so two clones on one machine never share a drive. It holds the drive state (rounds, attempts, verified commit, parked and held items, Ready-mark round) as one JSON document per pull request with its version, and as rows: the locks, the session and tree leases, the held-item and Ready-mark claims, the review round record (one row per head counted, which a hand-driven `/jig:resolve-review-comments` loop counts into too, so the drive's rounds start from what it counted), the driver generations and the driver record a stop recovers from. Clone-wide by design, *not* worktree-local: every linked worktree driving this PR shares one round budget, one parked set and one held batch, so a second worktree cannot silently re-arm an escalation the first one parked. The driver locks answer different questions, and only the PR-keyed one bears on "can this PR be driven twice":
  - `pr-drive-<PR>`, keyed by **PR** — refuses a second drive of *this PR* anywhere in the clone (exit `11`).
  - `pr-drive-worktree-<key>`, keyed by **working tree** (the filesystem canonical path of `--show-toplevel`, including Windows path aliases) — stops two drivers colliding over one checkout's files even when they drive *different* PRs. Separate worktrees are meant to run concurrently, so this key deliberately does not gate them.

  Each held item's `actor` stamp reuses that same tree key, but it only **records** which tree made a promise — it grants no exclusivity of its own.

  A lock or a lease names its holder by the plugin's shared process identity ([`shared/liveness.ts`](../../shared/liveness.ts)): the host id (compared before the host name, so a machine whose host name changed still recognises its own driver), the boot, the process id and its start time. A holder on another machine is never judged by this one's process table; one judged dead here (its pid gone, another process started under it, or the machine restarted since) is recovered at once, and one whose process still answers keeps its lock while it renews its heartbeat. On Windows a process records no start time and the machine no boot id, so a process id that now belongs to another process is not told apart from the holder: the lock is recovered when its heartbeat ages out. Releasing a lock deletes its row, so nothing is left behind. A session lease carries a generation that only grows: a command admitted on one generation is refused when it comes to mutate after another session took the lease over, and a pass whose lease was cleared and taken by a successor is refused its post (`assert-post-allowed.ts`).
- **The clone's directory** — `~/.local/state/jig/drive-pr/<clone-key>/`, beside the database (`resolveStateDir()` in `<skill-dir>/scripts/lib/state/store.ts`): what is read or appended as a file and queried by nothing — the driver log (`drive-pr-<PR>.log`), the answers a re-arm kept for its pass (`drive-pr-<PR>.answers.json`), a pass notice too long for one variable (`drive-pr-<PR>.notice.md`), the arm output (`drive-arm-<PR>.out`), the morning report's memory (`drives-report.json`) and, on Windows, a driver's process registry.
- **`.context/pr-drive-<PR>.md`** — the human-readable handoff: where the drive stands and how to resume.
- **The drive ledger** — one comment on the pull request, opening with the hidden marker `<!-- drive-pr-ledger -->`, that mirrors the resumable part of the drive state so a drive started in another clone or on another machine picks up where the last one left off: the round and phase, the last counted and verified heads, the Ready mark, every parked item with its decision, every held item with its outcome and pushed commit, the takeovers, the driver's working tree and last heartbeat, and the last twenty lines of the handoff narrative. The driver's `clone` is the clone key and, after an `@`, the first 16 characters of the host's id (a digest of the machine's id), so a reader can tell which host claims the drive and the comment names no machine; a ledger an earlier release wrote, which names its clone another way, still seeds. Nothing that identifies an account is posted: no account hash in the ledger or a takeover claim (the drive state keeps the quota park's account locally, so a re-arm from another clone simply tries, and the usage-limit handling meets the wall again if it is still there), and anything shaped like an email address or an account identifier in the narrative, a parked decision or a held finding's answer is replaced with `<redacted>`. It carries a version and a generation that grows with every write. The driver writes it at every round boundary, park and takeover, through a usage-limit sleep or a mailbox pause (as the wait starts, then every quarter of the shortest lease window any clone applies; a write that does not land is retried within minutes, and a newer takeover claim from another clone ends the wait with `TAKEN_OVER`), and when it stops. A driver stopped by `--stop` cannot write it itself, so `bun "<skill-dir>/scripts/drives.ts" --stop <PR>` marks the ledger stopped once the driver is witnessed gone. After Ctrl-C or another signal stop, run `--stop <PR>` or `--doctor` in that clone: against the driver record a driver marks released as it releases its locks, they do the same. Each writes only while the ledger still names that driver (its working tree, clone and run) with no newer takeover claim, so a successor's ledger is left as it is. A driver killed outright can leave a detached pass running. Dispatch and doctor reconcile its ledger only when acquisition-bound persistent observations prove the local driver and its observed and registered work gone; missing or uncertain evidence leaves it running and dispatch notifies a person. Recovery reserves the exact PR slot, publishes its termination witness atomically, and releases only its own temporary session leases, including on a retry after an interrupted recovery. A reset keeps the ledger's generation, so the next drive does not seed back what the reset forgot. A drive that starts with no state for the pull request, or with state older than the ledger's generation, seeds its state from it; a ledger version it cannot read stops it with exit `1`, naming the version. Only a ledger written by the drive's own login or by an owner, member or collaborator is trusted; any other comment carrying the marker is ignored and reported. A ledger too long for one comment loses the held items' outcomes first and the narrative second, never a parked decision. `DRIVE_PR_LEDGER=off` drives without it.
- **The pull request's state label** — where the repository turns the [pull request state labels](../../CONFIGURATION.md#dispatch) on (`dispatch.labels.enabled`, read from the default branch as the dispatcher reads it, no dispatcher needed), the drive labels its own pull request whenever it writes its ledger: `jig:driving` (under the default prefix) once it arms, before its first round, removing `jig:drive` in the same write, and at its stop the state the exit table it shares with the dispatcher gives (`scripts/lib/status/exit-classes.ts`): `jig:converged` for `CONVERGED` while the head is still the one it verified; `jig:parked` for a park, a stop only you settle (`MAX_ROUNDS`, `REVIEWER_FAILED`, `REVIEW_SKIPPED` among them), your own stop (a mailbox stop, or one through `drives.ts`) and a stop the dispatcher would re-drive (`PR_CONFLICTING`, `WORKTREE_UNCLEAN`, `STALLED`, `PASS_DEADLINE`, `CI_REPAIR_SPENT`, `CI_INFRA_PERSISTED`), which a dispatcher's tick turns into `jig:stale` where one runs; `jig:driving` for a stop the dispatcher re-arms or a second driver refused; nothing for a pull request no longer open or a drive taken over (the full list is in [terminal states](references/terminal-states.md#exit-codes)). It never writes `jig:stale` or `jig:held`, labels only a ledger it wrote itself, writes in one `gh` call only when the labels disagree, never on a pull request carrying `jig:hold` or `jig:held`, and never creates a label: run `jig dispatch labels --yes` once to create them. A refused write is one `labels:` line on the drive's output and never changes its exit; a dispatcher's next run corrects it where one runs, and otherwise create the missing label or set it by hand. To have `jig:converged` replaced with `jig:stale` as soon as a commit is pushed after convergence, copy [`templates/github/state-labels.yml`](templates/github/state-labels.yml) to `.github/workflows/` and set its `PREFIX`.
- **GitHub** — the shared truth: threads and their resolution state, outcome replies, the drive's announce comments, the drive ledger and takeover claims, the reviewer check-runs, the state label.

A database a newer plugin migrated is read as it is when every change since this plugin's version only added tables or columns, and refused, naming both versions, when it needs a newer reader. `bun "<skill-dir>/scripts/reap-state.ts"` (dry-run by default, `--delete` to act) removes a merged pull request's files from the clone's directory once no lease is live on it and they are a week idle, and the files an earlier release kept there a month after the database imported them; run it with `--delete` weekly from the machine's own scheduler if you drive many PRs. [Resource collection](../../gc/README.md)'s `tool-state` kind, once listed in `gc.kinds`, reports the same through the reaper's JSON but removes nothing. [`SKILL.md`](SKILL.md) § Running it (the *State reaping* entry) explains what it may and may not delete.

## Upgrading from a release that kept files

A release before the database kept the drive's machine state as files in the clone's directory: a `drive-pr-<PR>.json` per pull request, the lease files, the lock directories and their tombstones, the claims and the driver record. The first open of the database for a clone reads that directory in once — every state, every lease that parses, the driver locks' claims with their last heartbeat, the held-item and Ready-mark claims and the driver record — records the import (when, how much, and the files it could not read), and leaves every file where it is, for a person to inspect. A lease is read in under a new generation; a lock that guarded one read-modify-write, a tombstone, a stop request or completion is not read, since none outlives the command that wrote it.

Stop every drive before upgrading, or let it reach a terminal state: a drive still running the earlier release keeps writing files the database no longer reads, and its state after the import reaches this clone only through its ledger on the pull request, which a later drive seeds from when it is newer.

Displaced [lock quarantine](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) entries (`<lock>.stale.<generation>` and
`<lock>.recovering.stale.<generation>`, directories or marker files) are not
imported state. The reaper reports them as `quarantine:<clone>` with their
entry count and bytes, and keeps the family even with `--delete`. A suspended
legacy writer can resume after the last snapshot check; the database mutex
does not exclude it. Neither 24 hours without a write nor the absence of a
legacy lock proves exclusion. This applies even when the clone was never
imported, independently of the other files' 30-day import retention.

## Relocating the state dir

`$DRIVE_PR_STATE_DIR` relocates the state root: the database and every clone's directory. With an override of `/absolute/shared-state`, the database is `/absolute/shared-state/state.sqlite` and each clone's directory `/absolute/shared-state/<clone-key>/`. The default root is `~/.local/state/jig/drive-pr/`. The key is the first 16 hexadecimal characters of SHA-256 over a [universally unique identifier](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (UUID) persisted as `drive-pr-clone-id` in Git's common directory (the path `git rev-parse` prints for `--git-common-dir`). It survives a clone move, is shared by linked worktrees, and differs between separate clones, including clones of the same remote repository. Remote owner/name is not the key. Commands that resolve state, including the reaper, need the owning clone as their Git context; an override path alone outside Git does not identify a clone.

The intent-chain pin stays at `.context/intent-chain/pr.<N>.md` in the worktree (unless the separate `DRIVE_PR_INTENT_CHAIN_DIR` override relocates it) and does not use the override. The review round counter `await-round.ts` keeps for a hand-driven loop is a table of the database (`review_rounds`), so it moves with it.

The driver exports its resolved clone directory to its passes as `$DRIVE_PR_STATE_DIR`, and the database's instance id as `$DRIVE_PR_STATE_DIR_IDENTITY`. A path whose last component equals this clone's key is already resolved and is not nested again, and the database is the one beside it. A pass must keep that inherited path. Before a pass posts, the mutation fence checks that the database it reads is the one the driver opened: a database deleted and created again, or another file put in its place, has another instance id and does not hold the leases the drive's other sessions took, so the fence refuses rather than read no lease there as nobody driving. An override that arrives without the identity is refused too.

**A root that holds a drive's files directly**, as a flat override from a release before clone directories, is refused with the artifact and the current clone named: those files carry no repository, so whose they are is unknown. The tool neither adopts them nor starts a fresh history beside them, and never moves or rewrites them. Stop all participants, identify which clone owns each file, and move each clone's files into `<root>/<clone-key>/` by hand; the database imports that directory at its first open.

**The invariant is that every participant in one clone resolves the same root.** Two drivers that disagree open two databases: each mints a fresh, empty state for a PR the other is already driving, which presents as a drive silently restarting at round 0 with `verifiedSha` cleared while the real record sits in the other database. Changing it means changing it everywhere at once — a machine-wide export in the shell's startup file reaches the commands that shell starts, agent-tool hooks run in their own environment and need it in that tool's settings (Claude Code: `~/.claude/settings.json`'s `env`), and launchd/cron jobs read no shell startup file and need it written into their own configuration as an absolute path.

To move a root:

1. **Quiesce every participant.** Stop every live `drive.ts` (`bun "<skill-dir>/scripts/drives.ts" --stop <PR>` per PR, or wait for each to reach a terminal state) and disable any scheduled `bun "<skill-dir>/scripts/reap-state.ts" --delete` job — nothing may open the database during the move.
2. **Move the root whole**: the database with its `state.sqlite-wal` and `state.sqlite-shm` files when they are there, and every clone's directory, into the new root, with the file tools of your choice. Nothing in it names its own path.
3. **Only after that, export** `$DRIVE_PR_STATE_DIR` at the new root for every participant at once — the shell profile, the agent tool's settings and any scheduled job's configuration. Exporting before the move makes participants create a fresh database at the destination while the real record remains at the source.
4. **Verify and re-arm.** From a fresh shell, run `bun "<skill-dir>/scripts/drives.ts"` and confirm the moved drives are listed, then re-arm the stopped drives and re-enable the reaper.

A machine-wide export reaches every clone on that machine equally, and that is safe however many clones the machine runs: each clone's rows are keyed by its own key, so the same PR number in two independent clones names two separate states, locks and logs. Export the root, not one clone's directory, when several clones share it.

## Stopping and resuming safely

- **Stop:** `bun "<skill-dir>/scripts/drives.ts" --stop <PR>` verifies the driver's process identity, then sends it a mailbox `stop` addressed to its driver generation and marked to act at once. The driver reads its mailbox for it every quarter second, on every platform (Windows needs no POSIX signal for it; process snapshots come from PowerShell), stops the active pass, and acknowledges the stop in the outbox before releasing its locks. A later driver ignores the stop. The stop command requires that acknowledgement and the disappearance of its captured process identities when a temporary shutdown marker made the registry uncertain. A driver of a release before driver generations is sent no stop and is forced after the 30-second grace. With `--expect-started <ISO>` it stops only the driver that acquired the lock at that time, and exits `3` for any other. Ctrl-C also cancels the active work. Locks a dead driver leaves behind are recovered automatically by the next driver.
- **Resume:** run the same command again. The durable state means it continues rather than restarts, and threads already answered are reconciled rather than re-answered (`reconcile-replied-threads.ts` runs from the gate). A retry against an unchanged head is not a new *reviewed-head* round, but it does spend one of the durable **attempts**; within one uninterrupted drive, consecutive observable no-op passes (default 2) earn one extra round with the stall diagnostics and then trip exit `14`, while retries spread across driver restarts reset that in-memory stall streak and can still exhaust `--max-rounds` with exit `6`.

  The sweep and `triage-thread.ts` leave a declined code-scanning thread open until its alert is confirmed dismissed, and a `moot` one until its alert is fixed, closed or dismissed, including when the alert cannot be read or identified. A code-scanning `moot` is never held for a push: once its alert settles, the next retry resolves it.
  A legacy marked `moot` reply proves that no push was needed. Both direct retry and automatic reconciliation resolve it on a bot-started thread once any code-scanning alert is confirmed fixed, closed or dismissed; apart from that alert check, only a confirmed human starter permits leaving it open.
  The `--leave-open` option of `triage-thread.ts` is reserved for human-started threads and refuses a bot-started thread with exit `2` before posting or changing its disposition.
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

The cross-PR scoreboard (`scripts/fractal-metrics.ts`) also measures the share
of merged pull requests that met a conflict. It combines the sibling
`resolve-conflicts` history report with this clone’s live events and prints
conflicted, observed-clean and unknown counts over the forge’s merged PR
cohort. A clean observation requires replayed PR ancestry and no forge-recorded
force-push. The replay covers merges committed since the cohort's earliest
sampled commit, pull-request opening or merge; a pull request whose ancestry
holds an older merge stays unknown. A partial clone with git
before 2.45 leaves ancestry unknown rather than risk a fetch. The fleet-health file’s `merge_conflicts.coverage_floor` (default
`0.9`) and `baselines.merge_conflict_share.value` govern its verdict; the
whole-cohort bounds must agree too. Missing heads, rewritten branches and
resolutions in other clones limit coverage. A capped forge cohort has no
verdict. The report includes coverage and bounds in JSON and terminal output.

When reflection is due, the `drive-status.ts` summary starts with
`[REFLECT DUE]`; reflect before triaging the round.

Fleet health counts re-arms recorded in the pull request’s drive ledger as
ceremony, weighted by `ceremony.weights.drive_rearms` (default `1`). Handoffs
remain unmeasured because their narratives carry no dated history.

### The decision a park carries

A new park takes checked `ParkedDecision` JSON on standard input, with its
question, options, costs, recommendation, steps and work already done. Unknown
fields are refused by name. Each decision is limited to 8 KiB of UTF-8 JSON
and must fit the drive ledger's 65,536-byte budget with its other parks;
refusals name the sizes. The ledger redacts each string value separately.
Optional option details appear as labels and text on the card and in
`jig ask`. Decision sheets can supply a park through `parkFromSheet`, which
expands sheet references and requires a recommendation. Parks stored in the
older Markdown form still read until they leave the ledger. The authoring
format and command are in [the skill, § 4](SKILL.md).
