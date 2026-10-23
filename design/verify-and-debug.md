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
`debug`, and the evidence record they share. Nothing of it is built; `fix-ci`'s `probe-base.ts` and
`shared/junit-report.ts` are the parts that exist.

## The rule

> A statement that a check passed, or that a test was seen to fail, is backed
> by an **evidence record**: the command, the tree it ran against, its exit
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
(`~/.local/share/jig/evidence/<repository>/<tree-hash>/<command-hash>.json`,
under the same root the fleet-health snapshots use), and prints a short
block:

```
EVIDENCE  tree 3f9c2a1  bun run gates
exit 0  ·  2m14s  ·  412 cases ran, 0 skipped (junit: .reports/junit.xml)
record ~/.local/share/jig/evidence/example-web/3f9c2a1/8e1d.json
```

- **The tree, not the commit.** `git rev-parse HEAD^{tree}` plus a hash of
  the uncommitted diff when there is one, so a record made before an edit
  does not vouch for the tree after it.
- **Counts from the report.** Where the command writes a JUnit report, the
  record holds the cases run, skipped and failed from it
  (`shared/junit-report.ts`), never from the runner's summary line, and a
  zero count is marked as M14's [skip tripwire](../GLOSSARY.md) would mark
  it: not a pass.
- **Output kept short.** The first and last 60 lines, and the full output
  in a file beside the record. A record is evidence, not a log.
- **Expected failure.** `--expect-fail` records a run that must exit
  non-zero, with the failing case named: the seen-to-fail record for a new
  test. A run that passes under `--expect-fail` is recorded as a failure of
  the expectation.
- **Lookup.** `evidence.ts list [--tree <hash>]` prints the records for a
  tree, so a skill can ask "has the validation plan run against what I am
  about to push" without re-running it.

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
  agent returns and again after the fix loop, and `pr-plan.ts open` refuses
  (its policy exit `3`) when no record exists for the tree being pushed. The
  pull-request body gains an `## Evidence` section listing the records for
  the pushed tree: the plan, and the seen-to-fail record for each new test
  file the diff adds, when the work type requires one
  ([work types](work-types.md)).
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
4. **The ledger.** Every hypothesis goes in `.context/debug-<slug>.md`
   ([worktree scratch](../GLOSSARY.md)): the hypothesis, what was changed
   to test it, the verify record of the result, and whether it held. A
   hypothesis is written before its change is made.
5. **Fix, then verify both.** With the cause named, make the fix, then
   verify the reproduction command and the validation plan. The fix is
   described in terms of the cause, in the commit and the pull-request body.
6. **Stop and hand over.** After `debug.max_hypotheses` failed hypotheses
   (default 3) or `debug.time_budget_minutes` (default 45), the skill stops,
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
| `debug.max_hypotheses` | whole number ≥ 1 | `3` | debug |
| `debug.time_budget_minutes` | whole number ≥ 1 | `45` | debug |

## Build order

1. **The record.** `shared/evidence.ts` with its tests (tree hash, diff
   hash, report counts, expected failure, lookup), run from a plugin copy.
2. **`verify`.** The skill, its README, the lifecycle row, the M14 link.
3. **`do-item` and `fix-ci` record and require.** The policy refusal, the
   body section, the seen-to-fail requirement by work type.
4. **`debug`.** The skill, the ledger, the budget, the hand-off from
   `fix-ci`, tests with a fixture repository whose failure needs attribution
   and one whose budget runs out.

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
