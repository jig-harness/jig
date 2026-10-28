# Evidence before claims, and a debugging protocol: design

**What problem this solves.** An agent reports that the tests pass and shows
nothing; a reviewer, or the next session, has to run them again to know. A
failing check gets a fix before anyone names its cause, and when the fix
does not hold, a second and a third follow, each guessing. Jig states the
rules against both ([M14](../modules/M14-testing-strategy/README.md): a new
test is seen to fail, a failure is attributed on a
[fresh-base probe](../GLOSSARY.md) before it is fixed, a skipped suite is
not a pass) and runs pieces of them in `do-item`, `fix-ci` and `drive-pr`,
but no single thing records that a check ran against this exact tree, and
no procedure bounds how long an agent may keep guessing. With this built, a
claim that something works points at a record of the run that showed it,
and a failure whose cause is not obvious is worked through one protocol that
stops and hands over after a stated budget.

This is the design of [plan.md](plan.md) item 28: two skills, `verify` and
`debug`, and the evidence record they share. The record (step 1 of the
build order) is built: `plugin/shared/evidence.ts`, with its settings in the
[`verify` section](../plugin/CONFIGURATION.md#verify) of the configuration.
The two skills remain open; `fix-ci`'s `probe-base.ts` is the other part
that exists.

## The rule

> A statement that a check passed, or that a test was seen to fail, is backed
> by an [evidence record](../GLOSSARY.md): the command, the tree it ran against, its exit
> code, the count of test cases that ran from the runner's own report, and
> the output's head and tail. A record is tied to the tree hash, so an edit
> after the run invalidates it. A failure whose cause is not named is
> **reproduced, attributed, then narrowed** before it is fixed, and each
> hypothesis tried is written down; after a bounded number of them the agent
> **stops and hands over** with the ledger, instead of trying a fourth.

## How it works

### The evidence record

`plugin/shared/evidence.ts` runs a command and writes one record to the
[machine-local store](../GLOSSARY.md)
(`~/.local/state/jig/evidence/<repository>/<tree-hash>/<command-hash>/<run-id>.json`,
under the same root the fleet-health snapshots use), and prints a short
block:

```
EVIDENCE  tree 3f9c2a1  gates
exit 0  ·  2m14s  ·  412 cases ran, 0 skipped (junit: .reports/junit.xml)
record ~/.local/state/jig/evidence/example-web/3f9c2a1…/8e1d…/20261023T141502-4b7e.json
```

- **The tree, not the commit.** The tree hash of the working tree Git
  tracks or would track: `HEAD` plus every staged and unstaged change to a tracked file and
  every untracked file Git does not ignore, written into a temporary index
  (`GIT_INDEX_FILE`, `git read-tree HEAD`, `git add -A`, `git write-tree`;
  reading `HEAD` first keeps a tracked file that now matches an ignore rule
  or sits outside a sparse checkout) so the real index is
  untouched. A record made before an edit, or before a new untracked file
  appeared, does not vouch for the tree after it. Ignored files (installed
  dependencies, build output, caches) are outside the identity, and a
  record does not vouch for them: an edit there leaves the hash unchanged.
  The record says so in its scope field, and the inputs that decide them
  are covered instead. A lockfile or build configuration is tracked, so a
  change to it changes the hash. A command whose result depends on build
  output builds it inside the same run (the gates do), so no earlier
  build's output is trusted. Ignored state edited by hand outside both is
  the residual, and CI, which starts from a clean checkout, remains the
  authority over it.
- **The same tree after the run.** The hash is taken again when the command
  ends. When the two differ (another session, a formatter or the command
  itself changed a file the identity covers) the record is kept, marked
  `tree-changed`, and vouches for no tree: lookup never returns it as proof.
  An edit made and undone inside the run is not seen; a record answers
  for the tree the command started and ended on.
- **One record per run.** Every run gets its own id and its own file, and
  no run overwrites another: a failing run that a ledger cites stays there
  when the same command passes on the same tree later. Lookup indexes runs
  by tree and command and reads the newest that vouches for its run (on an
  unchanged tree and from a fresh report: a pass whose report failed no
  case and ran a case in every top-level suite, or a seen-to-fail in which
  every case the run named failed, whatever else failed beside it) unless
  asked for all of them.
- **Counts from the report.** Where the command writes a JUnit report, the
  record holds the cases run and skipped per suite, the failed cases
  across the report, and each case's own result (passed, failed or
  skipped; a case marked skipped is skipped whatever else it holds, as
  M14's check reads it), from it (`shared/junit-report.ts`, whose
  suites count run and skipped cases and whose cases carry the failure),
  never from the runner's summary line. A case is identified by its
  `classname` and `name` together, so two cases of one name in different
  classes stay two. The
  report must be this run's: before the command starts, `evidence.ts` moves
  any file at the report path aside, and after it ends reads the report only
  when one exists there again, written after the run began. A report left by
  an earlier run is never read, and a run that writes none is recorded as
  `no report`, which a check needing report-backed counts refuses. A suite
  that ran zero cases is marked as M14's [skip tripwire](../GLOSSARY.md)
  would mark it: not a pass, even when another suite in the same command
  ran.
- **A deadline on every run.** The command runs under a time limit
  (`--timeout`, default `verify.timeout_minutes`) through the plugin's
  process deadline, which ends the command's whole process tree, its
  descendants included, on expiry or when the caller is cancelled. A run
  that hit the limit is recorded as timed out, never as a pass or a
  failure of the code, and `debug`'s time budget counts it.
- **Output kept short, and kept local.** The first and last 60 lines, and
  the full output in a file beside the record. A record is evidence, not a
  log. Test and diagnostic output can carry credentials or personal data,
  so output never leaves the machine, and neither does the exact command
  line, which can carry them too (a token in a header, a password in a
  connection string). What travels to a pull request, an issue or a reply
  is the printed block, whose command field is a display name: the name the
  validation plan gives the check, or for any other command the program's
  name and the command hash, never its arguments. The block's other fields
  are the tree, exit, counts and record id, never a suite or case name from
  the report, and a ledger cites records by id instead of quoting their
  output. The store is readable by its owner alone.
  Records older than `verify.retention_days` (default 30) are collected as a
  kind of the [resource collection](resource-gc.md) runner, with its
  receipts.
- **Expected failure.** `--expect-fail` records a run that must exit
  non-zero, with the failing case named: the seen-to-fail record for a new
  test. A run that passes under `--expect-fail` is recorded as a failure of
  the expectation.
- **Lookup.** `evidence.ts list [--tree <hash>] [--all]` prints the records
  for a tree, so a skill can ask "has the validation plan passed against
  what I am about to push" without re-running it.

The store holds nothing the tracker lacks ([M9](../modules/M9-tasks-memory/README.md)):
losing it costs a re-run, never a decision.

### `/jig:verify`

The skill a person or a sibling calls to run something and keep the proof.
Its argument is a command, or nothing, which means the
[validation plan](../GLOSSARY.md): the catalog's plan for the current
diff when `drive.change_areas_catalog` is set, else `gates.command`. It
runs the command through `evidence.ts`, prints the block, and in a session
that will report upward (a pull-request body, a tracker comment, a reply to
a person) hands the block on. It also answers the question the rule
exists for: *what does your claim rest on?* A session asked that answers
with the record or runs verify.

Where it is used:

- **`do-item`** runs verify for the validation plan after the implementing
  agent returns and again after the fix loop. `pr-plan.ts open` gains a
  check beside its policy planning and refuses (its policy exit `3`) unless
  every command of the validation plan has a passing record on the tree
  being pushed: exit `0`, not timed out, and no suite marked by the skip
  tripwire. A record of another command, a failing run, or an
  `--expect-fail` record does not count towards it.
- **The pull-request body** gains an `## Evidence` section. It lists the
  plan's passing records for the pushed tree, and a seen-to-fail record for
  each test the diff adds. A seen-to-fail record ran before the fix, so it
  belongs to an earlier tree of the branch: it is listed with that tree and
  the test it names, and it counts when that test is in the pushed tree and
  has the case-level result passed in the plan's records there. Two requirements meet here and stay
  apart. [M14](../modules/M14-testing-strategy/README.md)'s seen-to-fail
  applies to every new test, a new file or a new case in an existing one,
  whatever the work type; `pr-plan.ts` finds new cases by comparing the case
  identities in the JUnit reports of the base and the pushed tree, and where no
  report names cases the body names the tests. A name in the body says
  which tests are new and records no run: such a test counts as seen to
  fail, and closes an increment, only through records of a command that
  emits a fresh case-level result for it, and without one it stays
  unaccounted. The work type's
  `test_first` ([work types](work-types.md)) is the stronger rule that the
  failing test is written before the fix. Commit times cannot show that,
  since a record covers uncommitted changes, so the check reads the
  seen-to-fail record's tree instead, against the increment before it.
  An increment opens with a seen-to-fail record and closes with the first
  passing plan record after it in which each of its tests has the
  case-level result passed: a skipped case closes nothing, whatever the
  suite's skip tripwire says, and a report without case results closes
  nothing either; seen-to-fail
  records made while an increment is still open join it, so tests written
  red one after another and then fixed together are one increment. Its
  baseline is the tree of the passing plan record that closed the previous
  increment, or the base when there is none, and always precedes the
  increment's first red run. A passing run that closes no increment is
  never a baseline, so an implementation change made between increments
  without a failing test of its own counts against the next increment.
  Every file outside the tests must read in each of the increment's
  seen-to-fail trees as it does in its baseline, compared path by path: a
  path present in one tree and absent from the other differs, so an added
  or deleted implementation file counts as a change, and a rename counts
  as both. A branch that writes test A, implements A, then writes test B
  meets it for B, whose red tree differs from A's green tree only in tests;
  one that writes test A and test B, each run red, then implements both,
  meets it for both, whose red trees differ from the base only in tests. A
  failing run made with part of its fix written since its baseline does
  not meet `test_first`. What trees cannot show is which increment a change
  serves: everything written between an increment's red run and its
  closing green record is credited to that increment, so part of a later
  fix written early, under an earlier test, reaches the later increment's
  baseline and passes the check. The check therefore certifies that each
  test failed before every implementation change since its baseline, and
  nothing about whether each increment's change was needed by its own
  test. That judgement stays with the reviewer, who has each
  seen-to-fail record's tree in the `## Evidence` section to compare.
- **`fix-ci`** records the local re-run of each fixed check, so "verify
  locally" in its name is a record rather than a sentence.
- **`drive-pr`** reads the body's evidence section when it certifies a
  converged head, and withholds nothing on its account: the record is for
  people and the next session, and CI remains the authority
  ([M1](../modules/M1-gates-enforcement-ladder/README.md)).

### `/jig:debug`

The skill for one failure whose cause is not obvious: a test that fails
after the first fix, a check that fails only in CI, behaviour that
contradicts the code as read. It is not `fix-ci`, which turns a failed run's
log into categorised errors and fixes the mechanical ones; `fix-ci` calls
`debug` for a `test_failure` or `gate_failure` that survives one fix
attempt, and names the budget it has left.

The protocol, each step with its record:

1. **Reproduce.** Get one command that fails, through verify, so the failure
   is a record and not a description. A failure that cannot be reproduced
   locally is worked from CI's artifacts and said to be so.
2. **Attribute.** When the failing test, the file it tests or their
   directory is not in the change, run `fix-ci`'s `probe-base.ts` first: a
   failure that reproduces on a fresh base is the base's problem, handled
   as M14 says (fixed inline when cheap, else removed with a tracker item
   that records what it covered), and `debug` ends there.
3. **Narrow.** Shrink the failing input, bisect the change when it is more
   than one commit, read the code on the path, and instrument with output
   rather than guesses. The aim of the step is a named cause: a sentence
   that says why the output is what it is.
4. **The ledger.** Every hypothesis goes in a
   [hypothesis ledger](../GLOSSARY.md), `.context/debug-<slug>.md`
   ([worktree scratch](../GLOSSARY.md)): the hypothesis, what was changed
   to test it, the verify record of the result, and whether it held. A
   hypothesis is written before its change is made.
5. **Fix, then verify both.** With the cause named, make the fix, then
   verify the reproduction command and the validation plan. The fix is
   described in terms of the cause, in the commit and the pull-request body.
6. **Stop and hand over.** After `debug.max_hypotheses` failed hypotheses
   (default 3) or `debug.time_budget_minutes` (default 45), the skill stops.
   The time budget bounds the runs inside it too: each verify run `debug`
   starts gets the smaller of its own timeout and the budget left, and a run
   still going when the budget ends is cancelled through the process
   deadline and recorded as timed out. The `probe-base.ts` run of step 2 is
   bounded the same way: its `--timeout` applies to each of its calls, so
   `debug` runs the whole probe under the process deadline with the budget
   left, and a probe cut off there could not decide. Every record the
   probe writes is durable before the step it guards: written to a
   temporary file, flushed and renamed into place. The probe records its
   worktree, its scratch directory and its `refs/probe-base/*` ref, with
   its own process identity, that way before creating each, so a probe
   killed at any point leaves no resource without a record; a resource
   recorded and never created is reported as absent. A setup or test command
   can leave a descendant running after it exits, and a killed probe can
   leave its Git, setup or test command running, because a descendant
   outlives its parent (ADR-0008); the same holds when the probe returns
   normally, throws, or hits its own `--timeout`. So the probe removes none
   of these resources on any path: the `finally` blocks that today run
   `git worktree remove --force` and a recursive delete instead write the
   probe's outcome into the record, and every resource the probe created
   stays for the report below. No holder may exist before its entry
   does: before starting each command the probe writes a pending launch
   entry naming the command and itself, durably in the same way, then
   starts the command
   asynchronously as the leader of its own process group, and only then
   adds the command's identity (process id and start time) to the entry
   before waiting on it. Process evidence cannot prove that every holder
   is gone: a descendant that leaves its process group, or on Windows any
   descendant, survives the captured identities, and ADR-0008 accepts that
   race only for cooperative cancellation, never as a licence to delete. So
   `probe-base.ts --reconcile` only reports; it never removes a resource.
   Per recorded resource it says whether every entry's holders were
   observed gone (the recorded identity no longer running and, on POSIX, no
   process left in its process group), whether one is still live, or
   whether it is unverified: a pending entry that never gained an identity,
   or a process table or identity that cannot be read. Removal is a
   person's act: the report prints, per resource, the commands that remove
   it (`git worktree remove` without `--force`, which refuses a dirty
   worktree, the scratch directory, the ref) for whoever has checked that
   nothing still uses it, since a holder no check can enumerate counts as
   live ([resource collection](resource-gc.md)). `debug` runs the report
   after every probe, however it ended, and puts it in its hand-over, and
   every probe runs it before starting and names each leftover it finds, so
   a probe that ended any way, under any caller, is reported by the next. The skill then
   posts the ledger where the work is tracked (the pull request when there
   is one, else the issue), names what it ruled out and what it would try
   next, and ends with the terminal state its caller understands: inside a
   drive, the CI-repair round's own budget; in `do-item`, a stop with the
   issue left `in_progress` and the ledger comment; for a person, the
   message.
7. **Learn.** A cause that a gate, a lint or an instruction should have
   caught is recorded through `/jig:reflect` when reflection is on, so the
   class reaches the review of reflections.

### What it touches elsewhere

- [docs/LIFECYCLE.md](../docs/LIFECYCLE.md): both skills in the table of
  skills outside the loop: `verify` when a claim that something works needs
  its record, `debug` when a failure's cause is not obvious.
- M14's README names `verify` as the runnable form of seen-to-fail and the
  skip tripwire on a developer's machine, and `debug` as the runnable form
  of triage before attribution, beside `fix-ci`.
- The plan's "the drive's CI-repair round running `fix-ci`" (Later) gains
  the hand-off to `debug` and its budget.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `verify.store` | folder | the machine-local store's `evidence/` | verify, do-item, fix-ci |
| `verify.output_lines` | whole number | `60` | verify |
| `verify.timeout_minutes` | whole number ≥ 1 | `30` | verify, debug |
| `verify.retention_days` | whole number ≥ 1 | `30` | resource collection |
| `debug.max_hypotheses` | whole number ≥ 1 | `3` | debug |
| `debug.time_budget_minutes` | whole number ≥ 1 | `45` | debug |

## Build order

1. **The record.** `shared/evidence.ts` with its tests (tree identity with
   untracked files, a tree changed during the run, one record per run,
   per-suite counts from a fresh report and a stale report refused, the
   deadline, expected failure, the redacted block, lookup), run from a
   plugin copy.
2. **`verify`.** The skill, its README, the lifecycle row, the M14 link.
3. **`do-item` and `fix-ci` record and require.** The policy refusal, the
   body section, the seen-to-fail requirement by work type.
4. **`debug`.** The skill, the ledger, the budget, the hand-off from
   `fix-ci`, tests with a fixture repository whose failure needs attribution
   and one whose budget runs out, and `probe-base.ts`'s resource record and
   `--reconcile`, tested by a probe killed after durably recording a
   resource and before creating it, reported absent, by one killed right
   after creating it, reported with its record, by a probe killed at its
   deadline during setup and during the command, whose worktree, scratch directory and ref are
   reported with their holders observed gone and are still present after
   the report, by a probe killed while its test command keeps running,
   reported live, by a probe killed after writing a pending entry and
   before recording a Git command's identity, and the same for a test
   command, reported unverified, by a command's child still alive in its
   process group after the command exits, reported live, by a probe that
   returns normally while a detached descendant of its test command still
   uses the worktree, and by one that throws an internal error, each
   leaving the worktree, scratch directory and ref in place and reported,
   and by an unreadable process table, reported unverified; no case
   removes anything.

## Left out

- **Evidence beyond a command's output.** A screenshot, a browser check or
  a deployed environment's response are evidence too; the record format
  leaves room for an `attachments` list, and nothing writes it yet.
- **Red-green for every change.** M14 asks that a new test be seen to
  fail, not that every change start from a failing test; the work-type
  table says where test-first is required.
- **A shared evidence service.** The store is machine-local on purpose; a
  record that must travel goes into the pull-request body.
- **Replacing `fix-ci`.** Its log parsing and priority order stay; `debug`
  begins where a mechanical fix ends.
