# drive-pr

**What problem it solves.** An AI-reviewed pull request (PR) rarely settles in
one pass: a reviewer posts findings, someone fixes them, the reviewer looks
again, and the loop repeats until nothing is left. Done by hand, that loop
depends on an agent session remembering where it stood, and it ends badly in
quiet ways: a session declares the PR finished while a reviewer is still
running, a fix is pushed to a PR that has already merged, or a long drive dies
with its context and nobody notices.

**What it does.** `/groundwork:drive-pr` runs a PR's review rounds unattended until exactly one terminal state: it waits for the reviewers to settle, triages every finding to one recorded outcome, implements the accepted fixes, runs the change-proportional validation plan, pushes, resolves the answered threads, and repeats. Each round is a fresh agent process, so a long converge never depends on one session surviving. It works draft PRs from birth and marks them Ready for review after its first completed round, so a paid external reviewer sees an already-cleaned head. After the PR-open continuous-integration (CI) run, it owns a temporary `ci:hold` label across intermediate fix pushes: the repository's workflows skip their expensive jobs on a held head while a required witness check fails fast, so those heads stay visibly non-green. At reviewer convergence it removes only its own latest label transition and waits for the unlabel-triggered full CI before reporting success. External removals retain the strongest available run-id watermark and require check starts strictly after the removal's second-granularity timestamp, so an ambiguous same-second run is rerun rather than trusted. When that CI comes back red, or when the PR conflicts with its base and no findings are left, it does not hand the job straight back: it runs a bounded **repair round** — a CI repair for the red CI, a base merge and conflict resolution for the conflict — and re-gates, falling back to the stop below only once that budget is spent. It stops on a state it names precisely: the terminal ones — convergence verified against the exact commit, a merged/closed PR, a conflict it could not resolve, findings that genuinely need you — plus the operational stops in the table below. It never approves, never merges, and never bypasses a hook.

This page is for **you, the human** — the operator contract agents follow is the skill itself: [`SKILL.md`](SKILL.md) and [`terminal-states.md`](references/terminal-states.md).

## Installation

The skill ships in the `groundwork` plugin, installed once per machine for
Claude Code and Codex; see [Groundwork's skills](../../README.md#install-the-plugin).
In a session it is `/groundwork:drive-pr`. Its scripts run from the plugin
directory with [Bun](https://bun.sh) and act on the repository the agent is
working in, so the target repository needs no copy of the skill. Git and an
authenticated GitHub CLI (`gh`) are also required, and each round runs the
sibling [`resolve-review-comments`](../resolve-review-comments/README.md)
skill's scripts from the same plugin.

Commands on this page write the skill's directory as `<skill-dir>`: the
`plugin/skills/drive-pr` directory inside the installed plugin (Claude Code
substitutes it as `${CLAUDE_SKILL_DIR}` in the skill itself). Run every
command from the root of the repository whose PR is being driven.

## Consumer configuration

Each repository keeps its values in `.config/groundwork-overlay.yaml`, the
same file [`resolve-review-comments`](../resolve-review-comments/README.md#consumer-configuration)
reads. Every field below is optional: a repository that sets none of them still
drives, on the defaults shown. A file that exists but cannot be parsed, or a
field of the wrong type, is an error rather than a silent default.

| Field | What it does | Default |
|-------|--------------|---------|
| `review.reviewer_app` | The GitHub App slug whose check runs, and whose sticky summary comment (posted as `<app>[bot]`), are the AI reviewer's evidence for convergence. `DRIVE_PR_REVIEWER_APP` overrides it | None: reviewer check runs are recognised by name alone (`DRIVE_PR_REVIEWER_CHECK`, default `^ai[ _-]?review(\s*\(.+\))?$`) from any app, and the sticky comment is accepted only from a login listed in `review.bots` |
| `repository.base_branch` | The branch rounds diff against (`origin/<branch>`). `DRIVE_PR_BASE_BRANCH` overrides it | Derived: the clone's `origin/HEAD` when it has one, else `gh repo view --json defaultBranchRef`, cached per process |
| `drive.validation_plan_command` | A command that reads the changed files (one per line) on stdin and prints the validation plan as JSON on stdout: `{validation: {localChecks: [...], verificationChecks: [...], testbox: {required, command, warmupCommand, requiredBy}}, reviewSkills: [...]}`. `round-plan.ts` runs it through the shell from the repository root | Unset: the plan is the single local check `gates.command` |
| `drive.load_guard_command` | A command `round-plan.ts` runs (in text mode) before printing the plan, which waits until the machine's load allows heavy checks | Unset: no load guard |
| `drive.change_areas_catalog` | Path, relative to the repository root, to a change-area catalog: YAML whose `areas:` map holds area key → `{paths: [globs], ...}`. `verification-fit.ts` validates `--area` against its keys | Unset: `--area` is recorded unchecked and the script reports the catalog as not configured |
| `drive.reviews_drafts` | `true` or `false`: does the AI reviewer review draft PRs. Used only to explain a draft PR that has no reviewer check run yet | Unset: unknown, and no hint is given |
| `drive.escape_baseline_doc` | Path, relative to the repository root, to the document recording the human-judged defect-escape baseline (`## Baseline window: <from> → <to>` headings, each followed by an `**Escape rate: <n> of <total> ...**` line). The loop-cost reports print its latest figure next to their speed numbers | `docs/review-loop-baseline.md`; a missing document reads as "unmeasured" |

The drive also uses two fields `resolve-review-comments` already reads:
`gates.command` (the complete local checks) and `review.bots` (reviewer
identities). `review.job_pattern` and `review.required_checks` govern only the
review skill's own passes; the drive's convergence decision does not read them.

**What the drive requires of the AI reviewer.** Having the review skill
configured is not enough to drive. The drive certifies convergence from one
posting reviewer that provides all of these:

- a check run whose name matches `DRIVE_PR_REVIEWER_CHECK` (default
  `^ai[ _-]?review(\s*\(.+\))?$`), from `review.reviewer_app` when one is set;
- a sticky summary comment carrying `DRIVE_PR_STICKY_MARKER` (default
  `<!-- ai-code-review -->`);
- in that comment, the commit it reviewed, stamped as `DRIVE_PR_SHA_MARKER`
  (default `ai-reviewed-sha`).

A reviewer without that protocol, such as CodeRabbit on its own, never
produces the evidence, and the drive waits in `AWAITING_REVIEWER` until
`--timeout`. Final certification also waits for a fixed set of required
continuous-integration checks (`REQUIRED_FULL_CI_CHECKS` in
`scripts/lib/ci-hold.ts`), which a repository's workflows must publish under
those names. Neither requirement is checked before a drive starts.

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
| `DRIVE_PR_STATE_DIR` | The drive's state directory (see § Where its state lives) | `~/.local/state/groundwork/drive-pr/<clone-key>/` |
| `GROUNDWORK_VERIFICATION_FIT_LOG` | Where `verification-fit.ts` appends its verdicts | `~/.local/state/groundwork/verification-fit.jsonl` |
| `DRIVE_PR_REAPER_LAUNCHD_LABEL`, `DRIVE_PR_REAPER_CRONTAB_MARKER` | Name a scheduled `reap-state.ts --delete` job, so `migrate-state-dir.ts` refuses while it is enabled | Unset: no schedule is checked |

### Push hold

`guarded-push.ts` refuses to push while an orchestrator has sent the PR a
`hold-push` directive (`mailbox.ts send`). A hold sent while the push's own
pre-push hooks are already running lands after that check, so a repository
that wants those holds honoured too runs `push-hold-recheck.ts` as its last
pre-push hook command. `guarded-push.ts` arms it by exporting
`DRIVE_PR_HOLD_RECHECK_PR`; an ordinary push skips it before `bun` starts:

```sh
[ -z "${DRIVE_PR_HOLD_RECHECK_PR+x}" ] && exit 0
bun "<skill-dir>/scripts/push-hold-recheck.ts"
```

It must run after every other pre-push command, or a later one reopens the
window it closes.

The other `DRIVE_PR_*` knobs (timeouts, repair budgets, stall and pause bounds)
are documented where they act, in [`SKILL.md`](SKILL.md) and
[`terminal-states.md`](references/terminal-states.md).

## When to reach for it

- **A PR exists and you want the review loop run to completion** → this skill. Normally you don't even start it by hand: a `/groundwork:do-issue` run arms the drive when it opens the draft PR. Typing `/groundwork:drive-pr [PR]` in a session does the same thing: the agent starts the driver below in the background, reports its log path, and stops — it does not work a round itself.
- **You want exactly one round, interactively, with yourself in the loop** → `/groundwork:drive-pr --interactive [PR]` (one in-session round, then stop), or [`/groundwork:resolve-review-comments`](../resolve-review-comments/README.md) (the drive wraps it).
- **CI is red and that's the only problem** → repair it directly, with the repository's CI-repair skill if it has one. (A drive already in flight repairs red CI itself, up to `DRIVE_PR_CI_REPAIR_ROUNDS` times; repair by hand when there is no drive running, or when its budget is spent.)

## How to start it

```bash
bun <skill-dir>/scripts/drive.ts <PR> --bots-only -- claude -p "/groundwork:drive-pr --bots-only <PR>"
```

The `bun` prefix and the single line are both deliberate, so don't "tidy" them: running the `.ts` file directly relies on its shebang and works on macOS/Linux only, and a `\` continuation works only in a POSIX shell — this form also runs on PowerShell and `cmd.exe`. It is the same command `/groundwork:do-issue` emits and spawns when it arms the drive for you, and the one `/groundwork:drive-pr` spawns from a session. The agent tells "a session asking for a drive" from "a pass the driver spawned" by `$DRIVE_PR_TARGET`, which only `drive.ts` sets — so a driver's own passes never arm another driver.

`--bots-only` keeps it off human-authored threads (recommended for unattended runs). `--keep-draft` stops it marking the PR Ready. `--max-rounds N` bounds the loop (default 10). `--dry-run` reports what each round would do and never invokes the pass. Starting it twice **in the same clone** is safe — see exit `11`. That is the exact reach: the lock lives in the per-clone state dir described below, so it covers this clone and its linked worktrees and nothing further. A separate clone — another machine, a CI checkout — takes its own lock and can drive the same PR at the same time.

## The exit states — what you do now

| Exit | State | What you do |
|------|-------|-------------|
| `0` | **`CONVERGED`** | The exact head is reviewer-clean, the worktree is clean, `ci:hold` is absent, and full non-reviewer CI is green with a fresh exact-head witness from the required checks. The merge decision is yours, never the drive's. **One caveat that is not optional:** if this drive marked the PR Ready, convergence is against the draft-reviewing AI reviewer **only** — marking Ready is what summons the reviewers that skip drafts, so anything they post lands *after* the drive ends. The drive says so on stderr; re-run it once they settle. `drive.ts` does **not** post the merge-ready announcement itself — run `bun <skill-dir>/scripts/announce-merge-ready.ts <PR>` if you want one on the PR. It re-checks convergence, non-reviewer CI, the absent hold, and a clean worktree before posting. `--dry-run` never invokes a pass, so a `0` from it is either this same convergence (the gate reached it first) or simply the command it *would* have run — the printed output says which. |
| `5` | **PR not open** (`PR_NOT_OPEN`) | The PR merged or closed while driving. Usually nothing to do — but if it happened *mid-round*, `guarded-push.ts` refused the push and **this round's commits are still local**, deliberately, so the work stays visible instead of landing on an orphaned branch. Check `git log origin/<branch>..HEAD` and either port those commits somewhere that will merge or discard them on purpose. |
| `8` | **HITL-parked** (`HITL_PARKED`) | Everything left needs a human call — arbiter escalations, human threads, parked summary findings. Read the round report / the `.context/pr-drive-<PR>.md` handoff, decide the parked items, then re-run the same command. It will **not** re-arm itself. |
| `9` | **Conflicting, nothing to work, and the repair budget is spent** (`PR_CONFLICTING`) | Either the drive spent the conflict-repair budget (`DRIVE_PR_CONFLICT_REPAIR_ROUNDS`, default 1) trying to resolve it and could not, or no repair pass ran at all — the budget is `0`/disabled, or the PR's base ref could not be read. Either way, merge the PR's **own base** in — not necessarily the default branch, since a release or stacked PR has a different one. The drive prints the exact command (`git fetch origin && git merge origin/<base>`) rather than guessing; use that. Then resolve, run the emitted validation plan, push, re-run. (A conflicting PR gets zero `pull_request` CI until you do.) |
| `12` | **Converged, but the tree is not clean** | The convergence is real; something local is unshipped. The causes and their fixes: uncommitted edits → commit or discard; an unconcluded merge/cherry-pick/revert/rebase/am → resolve or abort it; a local `HEAD` no longer matching the reviewed head → push it or reset. The last two leave `git status` **clean**, so don't stop there — the drive names which probe failed, and [`terminal-states.md`](references/terminal-states.md) lists them all. Then re-run. |
| `4` | Timed out / Ready-lease held elsewhere / no fresh CI witness (`NOT_SETTLED`) | Usually a reviewer that never answered, or another worktree's driver holds the Ready-mark lease. Check the reviewer check-run on the PR; re-run, or find the other driver. A third cause: the review converged and nothing is failing, but no fresh exact-head required-check witness showed up within `DRIVE_PR_FINAL_CI_WITNESS_POLLS` (default 30 minutes) — a required check whose fresh run completed **skipped** can never resolve this by waiting, so re-run the required checks on this head (a fresh run, not `gh run rerun` of the old one) and re-arm. |
| `6` | Max rounds | The bound fired before convergence — often a finding the agent cannot fix, or a reviewer past its own round ceiling. Read the last round report before re-arming with a higher bound. |
| `7` | Reviewer check failed (`REVIEWER_FAILED`) | The reviewer's check-run did not pass, so a "zero threads" read would be meaningless. Look at the check on the PR. |
| `10` | — | Retired (was `PR_IS_DRAFT`; the drive now drives drafts). Not recycled. |
| `11` | **Another driver is live** | The drive is already armed — in this worktree or another of this clone. Do nothing; do not kill the other driver. |
| `13` | `DRIVE_HELD_BY_OTHER_WORKTREE` | Another live *working tree* is mutating this PR's drive state, possibly through an interactive pass rather than another driver — a case not covered by `11` when the other session is not itself holding `drive.ts`'s PR/worktree locks. Inspect with `drive-state.ts lease <PR> --all`; wait for the holder, or take over with `drive-state.ts clear-lease <PR> --all` once you have confirmed it is dead. |
| `14` | **Stalled** | `$DRIVE_PR_STALL_ROUNDS` (default 2) consecutive passes changed nothing this loop can observe — the reviewed head, local head, and every unresolved-thread/summary-finding/parked-key set all came back identical. The measured cause is a pass exiting 0 without acting (e.g. standing down against its own parent driver) while the round headers still look healthy. Read the pass output for what it decided, fix why it did not act, then re-arm the same command. |
| `18` | `MAILBOX_STOPPED` | A mailbox `stop` ended the drive after any active pass and its Ready transition finished. Send `resume --target stop` before re-arming. |
| `19` | `MAILBOX_PAUSE_TIMEOUT` | A mailbox `pause` stayed active for `$DRIVE_PR_PAUSE_MAX_SEC` (default 30 minutes). Send `resume --target pause`, then re-arm. The driver releases its locks on this exit. |
| `1` / `2` | Pass failed / usage error / **CI still red** | Operational. Read stderr; `2` usually means the command line itself is wrong, but can also mean `UNSUPPORTED_CLI` — a `gh` too old to report a required PR field such as draft state or mergeability. For that case, upgrade `gh`; it is not a CI-repair matter. `1` is also the CI stop: the review converged but full CI on the converged head is red and the repair budget (`DRIVE_PR_CI_REPAIR_ROUNDS`, default 2) is exhausted or disabled (`0` skips repair entirely and stops on the first red), or the verdict was unreadable rather than a named failure. Repair CI by hand, then re-arm. |

One red-CI cause is worth ruling out before you repair anything: a drive that **died** mid-round leaves its `ci:hold` label behind, and the repository's held-head check then fails the required witness check on a perfectly healthy PR. Check `gh pr view <PR> --json labels` first. If it is there, push whatever the dead drive stranded, then `gh pr edit <PR> --remove-label "ci:hold"` — the removal itself retriggers CI. Do **not** `gh run rerun` the old run: it replays the original event payload, which still carries the label, so it fails on the hold step again.

## What it will never do

- **Merge, approve, or request changes** on the PR.
- **Mark Ready before a completed round**, mark Ready under `--keep-draft`, or **re-mark a PR you converted back to draft** — the transition is once-only and defers to you.
- **Touch human-authored threads** under `--bots-only`.
- **Resolve an accepted thread before its fix's push is verified** on the remote head — a fix that failed gates is not a fix.
- **Bypass repository hooks or the emitted validation plan.** There is no `--no-verify` path.
- **Start a second loop on the same PR *from this clone*** — the per-PR lock refuses (exit `11`). A drive launched from a *different* clone is outside that lock's reach and is not prevented — see § How to start it.

## Where its state lives

- **The per-clone state dir** — `~/.local/state/groundwork/drive-pr/<clone-key>/` by default (`resolveStateDir()` in `<skill-dir>/scripts/lib/state/store.ts`; `$DRIVE_PR_STATE_DIR` overrides it — § Relocating the state dir) — the drive state (rounds, attempts, verified commit, parked/held items, Ready-mark round), the round counter, the locks, the leases. Clone-wide by design, *not* worktree-local: every linked worktree driving this PR shares one round budget, one parked set and one held batch, so a second worktree cannot silently re-arm an escalation the first one parked. The locks answer different questions, and only the PR-keyed one bears on "can this PR be driven twice":
  - `pr-drive-<PR>.lock`, keyed by **PR** — refuses a second drive of *this PR* anywhere in the clone (exit `11`).
  - `pr-drive-worktree-<key>.lock`, keyed by **working tree** (`--show-toplevel`) — stops two drivers colliding over one checkout's files even when they drive *different* PRs. Separate worktrees are meant to run concurrently, so this key deliberately does not gate them.

  Each held item's `actor` stamp reuses that same tree key, but it only **records** which tree made a promise — it grants no exclusivity of its own.
- **`.context/pr-drive-<PR>.md`** — the human-readable handoff: where the drive stands and how to resume.
- **GitHub** — the shared truth: threads and their resolution state, outcome replies, the drive's announce comments, the reviewer check-runs.

The state dir grows with every lock generation. `bun <skill-dir>/scripts/reap-state.ts`
(dry-run by default, `--delete` to act) compacts what is still in use and
deletes the files of merged PRs and removed worktrees; run it weekly from the
machine's own scheduler if you drive many PRs. [`SKILL.md`](SKILL.md) § Running
it (the *State reaping* entry) explains what it may and may not delete.

## Relocating the state dir

`$DRIVE_PR_STATE_DIR` overrides the default state directory
(`~/.local/state/groundwork/drive-pr/<clone-key>/`) outright and skips the
legacy-location migration guard. The override does not move existing state:
migrate it using the procedure below **before** exporting the new path, or the
drive can start with an empty round and lease history. The same procedure moves
state left in an older default location into the current one. Legitimate uses
beyond the test harness: a machine that cannot afford the default location —
an IDE or backup tool watching the whole home directory, say.

**The invariant is that every participant in one clone resolves the same
directory.** Two drivers that disagree do not share the lease mutex: each mints a
fresh, empty state for a PR the other is already driving, which presents as a
drive silently restarting at round 0 with `verifiedSha` cleared while the real
record sits in the other directory. Changing it means changing it everywhere at
once — a machine-wide export reaches `zsh -c` invocations, agent-tool hooks run
in their own environment and need it in that tool's settings (Claude Code:
`~/.claude/settings.json`'s `env`), and launchd/cron jobs read no shell startup
file and need it written into their own configuration as an absolute path.

1. **Quiesce every participant.** Stop every live `drive.ts`
   (`bun <skill-dir>/scripts/drives.ts --stop <PR>` per PR, or wait
   for each to reach a terminal state) and disable any scheduled
   `reap-state.ts --delete` job (`launchctl unload`, or comment out the
   `crontab -e` entry) — nothing may read or write the state directory during
   the move.
2. **Migrate.** Move a whole state root (one subdirectory per clone), or one
   clone's directory, into the current root:

   ```bash
   bun <skill-dir>/scripts/migrate-state-dir.ts --from <old dir> [--to <new root>]
   ```

   `--to` defaults to the current state root
   (`~/.local/state/groundwork/drive-pr`); `~` is expanded. To move one clone's
   directory to an exact destination instead, pass both absolute paths:
   `migrate-state-dir.ts /absolute/current/state-dir /absolute/new/state-dir`.

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
   `bun <skill-dir>/scripts/drives.ts` and confirm that no drives
   remain live from before the move and that the new directory holds the moved
   files. Then re-arm the stopped drives, and update and re-enable any
   scheduled reaper so it picks up the new path.

A machine-wide export reaches every clone on that machine equally, and state
files and locks key only by PR number, never by clone or fork — so one shared
export is safe only on a machine with a **single** clone. A machine running
several independent clones, where the same PR number could name unrelated work
in each, needs distinct, clone-specific values.

## Stopping and resuming safely

- **Stop:** Ctrl-C (or `SIGTERM`) is safe. Signals are forwarded into the whole child tree; the in-flight pass ends; locks a dead driver leaves behind are recovered automatically by the next driver.
- **Resume:** run the same command again. The durable state means it continues rather than restarts, and threads already answered are reconciled rather than re-answered (`reconcile-replied-threads.ts` runs from the gate). A retry against an unchanged head is not a new *reviewed-head* round, but it does spend one of the durable **attempts**; within one uninterrupted drive, consecutive observable no-op passes trip exit `14` (default 2), while retries spread across driver restarts reset that in-memory stall streak and can still exhaust `--max-rounds` with exit `6`.
- **Inspect without touching:** `bun <skill-dir>/scripts/drive-status.ts <PR> --json --once --no-count` answers "what would the drive do now" without doing it. `--no-count` is what makes that true — without it the probe *counts* its own evaluation as a round on this head, moving the durable counter that a later drive's `--max-rounds` bound and reflection nudge both read.

If a drive died mid-round hours ago, just re-arm — recovery is the designed path, not an exception.

## Changing this skill

Read [`references/consistency.md`](references/consistency.md) first. The
tests live in `__tests__/` and run from the Groundwork repository root with
`bun test plugin/skills/drive-pr` (the root `bunfig.toml` supplies the test
preloads); they never run from the plugin cache.
`__tests__/terminal-states-consistency.test.ts` checks that every terminal
state's exit code agrees across `scripts/`, `SKILL.md`, this page and
`references/terminal-states.md`.
