---
name: fix-ci
description: "Fix a failing CI run on a branch or pull request: parse the failed run's log, fix every error in priority order, verify locally, then commit and push."
argument-hint: "[run-id | #PR | --pr <number> | --branch <name>]"
context: fork
allowed-tools: "Read Edit Write Grep Glob Bash(gh run *) Bash(gh pr *) Bash(gh api *) Bash(git *) Bash(bun *)"
---

# Fix CI errors

Fix every error from a failed GitHub Actions run until the local checks pass,
then commit and push. CI ([continuous integration](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) is
the service that runs the repository's checks on every push; this skill turns
its red run into a green one without guessing. The checks it repairs are the
repository's quality gates, the subject of Jig module
[M1 (gates & enforcement ladder)](https://github.com/jig-harness/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md).
GitHub Actions is the one CI service it fetches logs from so far; with another
CI service, save the failed run's log to a file and pass it with `--log`.

Jig maintains this procedure and ships it in the `jig` plugin.
Each repository supplies its own values in `.config/jig.yaml`
(the [consumer overlay](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)); every value this skill reads
has a fallback, so it also works in a repository without that file.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository whose CI failed. Never `cd`
into the skill directory: the scripts find the repository and its
configuration from the working directory.

If the repository pins its tools with a version manager (for example
[mise](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)), make sure it is active in the shell before you
run the repository's own commands.

## Arguments

`$ARGUMENTS` — optional:

- nothing: the latest failed run on the current branch;
- a run ID, `12345678`: that run;
- a pull request, `#123` or `--pr 123`: the latest failed run on its branch;
- a branch, `feature/x` or `--branch feature/x`: the latest failed run on it.

**Local only, no pull request yet.** There is no failed run to fetch, so skip
Step 0's log parsing. Resolve the validation plan for the current diff (Step 3
shows the command) and run every check it prints to discover what actually
fails; the commands in Step 2 fix and regenerate, they do not discover. Fix the
findings in Step 2's priority order, and re-run the specific failing check
after each fix, not just the whole plan, before moving on.

## Scripts

### `scripts/consumer-config.ts`

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/consumer-config.ts"
```

Prints the values this procedure uses:

| Value | Source | When absent |
|-------|--------|-------------|
| `package_manager`, `install_command`, `relock_command` | detected from the lockfile at the repository root | no install step |
| `gates.command` | the overlay: the repository's complete local checks | the checks the repository's instruction file (`AGENTS.md` or equivalent) names |
| `drive.validation_plan_command` | the overlay: prints the checks a diff needs | the plan is `gates.command` |
| `fix_ci.regenerate_commands` | the overlay: commands that regenerate committed generated files | none: find the command as Step 2 describes |

Exit 2 means the configuration file exists but is invalid: report the message
and stop.

### `scripts/parse-ci-log.ts`

Fetches the failed run's log with `gh` and sorts its errors into categories,
in fix-priority order.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts"                # latest failure on the current branch
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" 12345678       # a specific run
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" --pr 318       # latest failure on a pull request
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" --branch feature/x  # latest failure on a branch
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" --log ci.log   # a saved log, no fetch
```

| Priority | Category | What it catches |
|----------|----------|-----------------|
| 0 | `schema_drift` | Database schema drift: the schema file or ORM schema disagrees with the migrations |
| 1 | `build_error` | Module resolution: `Cannot find module`, `Module not found` |
| 2 | `drift_check` | Generated-file drift: API specs, type surfaces, error-code registries, generated API clients |
| 3 | `typescript` | TypeScript compiler errors (`TS2xxx`, `TS7xxx`) |
| 4 | `biome_lint` | Lint diagnostics (`lint/<group>/<rule>`, positioned `error` lines) |
| 5 | `test_failure` | `FAIL <file>.test.ts` (or `.spec.ts`), assertion paths |
| 6 | `gate_failure` | Catch-all for other failed checks that print an error annotation (`::error`, `##[error]`, `❌`, `✗`, `error:`, `failed:`): grep gates, ratchets, self-tests |
| 7 | `process_exit` | The runner's generic `##[error]Process completed with exit code <n>.`: a step exited nonzero, for any reason |

The language-specific categories (`build_error`, `typescript`, `biome_lint`,
`test_failure`) recognise a TypeScript stack: Node-style module resolution, the
TypeScript compiler, Biome, and test files named `*.test.ts` or `*.spec.ts`;
the two drift categories match their messages' wording in any stack. Errors
from any other language or tool arrive as `gate_failure`
when their line opens with an error annotation, and otherwise only as the
step's `process_exit`; read the log for those.

Output:

```json
{
  "run_id": "12345678",
  "errors_found": 5,
  "summary": {"typescript": 3, "biome_lint": 2},
  "files_affected": ["src/cart/total.ts"],
  "errors": [{"category": "typescript", "job": "build", "step": "Run tsc", "file": "src/cart/total.ts", "line": 12, "column": 7, "code": "TS2322", "message": "...", "raw": "..."}]
}
```

`job` and `step` name the job and step that printed the line; the parser
keeps one entry per step for a line repeated across steps. When there is
nothing to parse it prints `{"error": "no_failed_runs", ...}`
(`gh` listed no failed run) or `{"error": "PR #<n> not found", ...}` (`gh`
reported no such pull request) with `errors_found: 0` and exits 0.
Exit 1 means a lookup or the log could not be fetched (or, with `--log`,
read), or `gh` answered with something unreadable (for example, an
authentication failure, a timeout, or a run still in progress); `gh`'s
message is on stderr. Report it and stop: it says nothing about whether CI
failed. Exit 2 is a usage error, including a detached `HEAD` with no run ID,
`--pr` or `--branch` to say which run to read.

### `scripts/probe-base.ts`

Runs a failing check again on a freshly fetched base, in a throwaway
[worktree](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), so a test
failure is attributed before it is fixed (the
[fresh-base probe](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)).
The command after `--` is spawned as given, with the worktree as its working
directory; the checkout you run it from is never touched.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/probe-base.ts" --base main --expect "total rounds to cents" --junit probe.xml -- bun test src/cart/total.test.ts --reporter=junit --reporter-outfile=probe.xml
bun "${CLAUDE_SKILL_DIR}/scripts/probe-base.ts" --base develop --remote upstream --timeout 300 --setup "uv sync" --expect test_total_rounds --junit probe.xml -- uv run pytest tests/test_total.py --junitxml=probe.xml
bun "${CLAUDE_SKILL_DIR}/scripts/probe-base.ts" --base main --expect "TS2322: Type 'string' is not assignable" -- bunx tsc --noEmit
```

A command that fails on the base proves only that something failed there
(a missing install, an import error, a runner that found nothing, another
test), and a test's name in the output proves nothing either: a passing
test prints its name too. So for a test, the command writes a JUnit report
(the runner's flag is in M14's mappings, under *Skipped is not passed*),
`--junit` names it as a path inside the worktree, and `--expect` is the
failing test's name: the verdict is that test case's own result on the
base, pre-existing when it failed there and the change's when it passed,
whatever else failed beside it. The cases named exactly that are read when
there are any, otherwise the cases whose name holds it. A report already
at that path on the base is removed before the command runs, so only the
report the command writes is read. No case by that name, cases by that
name with different results (a skipped one among them), only skipped ones,
no report, a report that is not well-formed JUnit, or one that is a link or
lies under a link leading out of the worktree: it cannot decide (exit 2). Without `--junit`, for a check with no per-case report (a type
check, a lint, a build), `--expect` is the error message CI showed, and the
failure is pre-existing only when the command fails on the base with that
text in its output; a failure without it cannot decide (exit 2).

The worktree starts with nothing installed (no `node_modules`, no virtual
environment, no `vendor/`): `--setup` names the repository's install
command (`install_command` from Step 0's configuration), run through the
Bun shell (`bun exec`) in the worktree before the command; a setup that fails is no answer
(exit 2). Install into the worktree itself: an install that links the
package to the working checkout (an editable install, a workspace link)
runs the change's code against the base's test and gets the verdict
backwards. Setup uses Bun's built-in shell on every platform and needs no
Git Bash installation. The configured install command must use syntax and
programs available in that environment. The setup runs in a shell of its own,
so the command must find
what it installed without activation: `uv run pytest`, `.venv/bin/python -m
pytest`, `bundle exec rspec`, never a bare `pytest` that resolves from the
caller's environment.

It fetches `<remote> <base>` first (`--remote`, by default the repository's
remote: `repository.remote`, else `origin`), into a ref of its own, and checks out
the commit that ref names: never the remote-tracking ref already present
locally, which is only as fresh as the last fetch, and never `FETCH_HEAD`,
which another fetch can overwrite. `--timeout` bounds each git call, the
setup and the command on its own, not the probe as a whole: a slow fetch, a
slow setup and a slow command can together take several times as long. One JSON line on stdout gives the base, the
commit probed, the expected text, the `evidence` the verdict rests on
(`junit` or `output`), the command, its exit status there and the
`verdict`; the tail of the command's own output is on stderr as evidence.

| Exit | Meaning | What to do |
|------|---------|------------|
| 0 | the named test case passed on the base or, without a report, the check did (`"verdict": "change"`) | the failure belongs to the change: fix the code, or the test if its assumption is what the change made stale |
| 1 | the named test case failed on the base or, without a report, the check failed there showing the expected text (`"verdict": "pre-existing"`) | the failure is not this change's: triage it as Step 2's `test_failure` says |
| 2 | could not decide: not a git repository, the fetch failed, no worktree could be made, the setup failed, the command could not start or either ran over the deadline, the report gave no answer for the named case, or the check failed without the expected text | fix what the message names and run it again; a fetch that fails is no answer |

## Step 0: Parse the CI errors

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/consumer-config.ts"
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" <run-id-or-options>
```

Read the JSON. If `errors_found` is 0:

- `"error": "no_failed_runs"`: report that no failed run was found.
- The run failed but no error was parsed: fetch the raw log with
  `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <RUN_ID> --log-failed` and investigate.

> **Cancelled, not broken?** Check the run's conclusion and its jobs'
> annotations before analyzing code. A job's ID is also the ID of its check
> run, which holds the annotations:
>
> ```bash
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <RUN_ID> --json conclusion --jq '.conclusion'
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion!="success") | {databaseId, name, conclusion}'
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh api "repos/{owner}/{repo}/check-runs/<JOB_ID>/annotations" --jq '.[].message'
> ```
>
> `Canceling since a higher priority waiting request exists` or
> `The operation was canceled.` means a concurrency cancellation, not a code
> bug. Assertions that fail because later steps ran on partially prepared
> state are false positives. Push a no-op commit (or wait for the next run);
> do not analyze the setup steps, test data or workflow files.
>
> **Integration or end-to-end failure whose cause is not in the log tail.**
> `--log-failed` shows the failed step's tail, which routinely leaves out the
> service log lines that name the cause (an authentication rejection, a
> startup crash). Those lines are in the job's own log, not in a separate
> artifact: fetch the full, untruncated log of the failing job.
>
> ```bash
> # Find the failing job, then pull its FULL log (not --log-failed)
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {databaseId, name}'
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --stdout-file job.log -- gh run view --job <JOB_ID> --log
> # Only when a run actually uploaded a log artifact (rare):
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh api "repos/{owner}/{repo}/actions/runs/<RUN_ID>/artifacts" --jq '.artifacts[].name'
> ```
>
> The root cause of an integration failure usually sits deeper in the job log
> than the failed step's tail; hours of fixes aimed at the tail are the usual
> cost of skipping this.
>
> **Only a task runner's summary, no error block?** When a monorepo task runner
> (Turborepo, Nx and similar) runs many packages' tests at once, a failing
> task's output is interleaved and buffered, and both `--log` and
> `--log-failed` can omit it. If the log shows only `Failed: <package>#<task>`
> without the failing test's output:
>
> ```bash
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {databaseId, name}'
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --stdout-file job.log -- gh run view --job <JOB_ID> --log
> ```
>
> **CI never started after a push?** Check the pull request's merge state
> first:
>
> ```bash
> bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>" --jq '.mergeable_state'
> ```
>
> - `dirty`: merge conflicts block CI. Resolve them, then push.
> - `blocked`: branch protection blocks it (approvals and the like).
> - `clean` or `unstable`: CI should start; check whether the workflow is
>   enabled and whether a run limit was hit.
>
> Do not close and reopen the pull request or push empty commits until
> `mergeable_state` is confirmed not `dirty`.

## Step 1: Plan the fixes

From the parsed JSON, list every error with its file, its type or code, a
short description and the planned fix. With five or more errors, track them in
the harness's task list (Claude Code: `TaskCreate`), or a checklist in your
status message where it has none.

## Step 2: Fix all errors, in priority order

If a package manifest or the lockfile changed, run `install_command` from
Step 0 first, before the schema and drift steps below, so they see the
dependencies the lockfile records. If it fails because the manifest and the
lockfile disagree, the lockfile itself is stale: run `relock_command` to
regenerate it, then run `install_command` again to confirm the result is
reproducible before continuing.

Fix in the order the parser prints (already sorted by priority):

### schema_drift (priority 0)

Regenerate the schema with the repository's schema command from
`fix_ci.regenerate_commands`. Never edit the generated schema file by hand.

### build_error (priority 1)

Fix import paths, missing modules and build configuration.

### drift_check (priority 2)

A generated file has diverged from its source. Regenerate it; never hand-edit
the generated file. Run the command from `fix_ci.regenerate_commands` that
produces the failing file (the check's log usually names the file or the
command), then run the drift check itself to confirm. When the overlay lists
none, or none fits, find the command beside the check: a drift check usually
has a regenerating counterpart in the same script manifest (`package.json`
`scripts`, a `Makefile`, a `justfile`), named like `generate:<x>` for a
`<x>:check`. [M2 (generated-artifact freshness)](https://github.com/jig-harness/jig/blob/main/modules/M2-generated-artifact-freshness/README.md)
describes the regenerate script, drift check and commit-time hook that keep
these files fresh.

### typescript (priority 3)

Fix the types. Do not silence an error with `any`, a cast or a suppression
comment: use `unknown` and a type guard where the type is genuinely open, and
follow the repository's own type rules (its instruction file and decision
records).

### biome_lint (priority 4)

Try the linter's auto-fix on the reported files first, run through the
repository's package manager (with Biome: `biome check --write <file> ...`).
Fix what remains by hand. With Biome, a suppression comment goes inside the
block it suppresses, not above an `export`.

### test_failure (priority 5)

Read the failing test and understand its assertion. **Fix the code, not the
test, unless the test encodes a stale assumption**: that is the order of
preference, not an either-or.

**Attribute before you fix.** Where the failing test, the file it tests or
their directory is not in the branch's diff, do not assume the change broke
it: run the fresh-base probe on that one file, with the base the pull
request merges into (`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh pr view <PR> --json baseRefName --jq .baseRefName`).
`<PR>` is the pull request you were given; otherwise the open pull request
of the branch you were given, or of the failed run's head branch
(`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh run view <run-id> --json headBranch --jq .headBranch`,
with the `run_id` `parse-ci-log.ts` reported, which also covers a detached
working tree): list every match with
`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh pr list --head <branch> --state open --json number,baseRefName`.
One match is `<PR>`. Several (pull requests from the same branch name into
different bases) are told apart only by the run: take the one the run names
(`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh api "repos/<owner>/<repo>/actions/runs/<run-id>" --jq '.pull_requests[].number'`),
and when that does not single one out, stop and ask which pull request the
failure belongs to rather than pick one. Use the repository's default branch
only when that branch has no pull request.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/probe-base.ts" --base <base> --setup "<install_command>" --expect "<the failing test's name from the CI log>" --junit probe.xml -- <the repository's test command> <failing test file> <the runner's flag writing a JUnit report to probe.xml>
```

A test is probed with `--junit` and its name: a verdict from the output
alone (`"evidence": "output"`) is about the check, not the test, and never
calls a test stale.

`--setup` is the repository's install command (`bun install
--frozen-lockfile`, `pnpm install --frozen-lockfile`, `uv sync`), since the
throwaway worktree has nothing installed; drop it only where the test
command needs no install (Go, the JVM and .NET resolve through a shared
cache).

Never reproduce on the base with `git stash` or by checking the base out in
the working checkout: worktrees share one stash stack and one set of
branches, and either can revert another session's work. Exit 2 (the fetch
failed, no worktree, a report with no answer for the named case) is not a
verdict: fix what it names and run it again. A different
failure on the base usually means the setup did not install what the test
needs; never read it as a stale test.

- `"verdict": "change"` (exit 0): the failure is this change's. Fix the code,
  or the test when the change deliberately altered the behaviour it asserts.
- `"verdict": "pre-existing"` (exit 1): the test is **stale**: the same
  test case failed on the base, so its failure predates the change. Then, in this order:
  1. **Fix it inline when the fix is cheap** (an assertion value, a mock's
     return value, an import path, a renamed export): read the implementation
     to learn the current behaviour, apply the smallest fix, run that file.
  2. **Otherwise delete it and open a tracker item** that records what it
     covered: the file, how many cases, the behaviours and failure paths they
     asserted, the failing output and why it was not fixed inline. The item
     is the test's replacement until a new test exists; a deletion without
     one loses the coverage silently.
  3. **Regenerate it only when its premise is obsolete** (its setup mocks a
     dependency shape that no longer exists, it was written against a
     replaced architecture). List every behaviour the old assertions protect
     first; the new test asserts each of them, and the old one goes only once
     each is covered. Never regenerate a test to make a failing assertion go
     away.

  Report the base commit the probe named, so the pull request says the
  failure was there before. A red base is the base's problem as much as this
  change's: the integration branch can stay red without any pull request
  going red when the per-change checks are scoped to the diff, which is why
  [M13](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/README.md)
  asks for an unscoped run there.

The rule itself, independent of this skill, is
[M14's triage section](https://github.com/jig-harness/jig/blob/main/modules/M14-testing-strategy/README.md#core-pieces).

**Bun: tests pass alone but fail together?** That is `mock.module()`
contamination: a module mock leaks into the other test files of the same run.
Make every `mock.module(...)` in the package provide all exports that any test
in that package uses, or inject the dependency (a constructor parameter or
loader) instead of mocking the module. Verify by running the files together:

```bash
bun test <file1>.test.ts <file2>.test.ts
```

**Never convert production code to dynamic imports to fix a mock problem.**

### gate_failure (priority 6, the catch-all)

A check written for this repository failed: a [grep gate](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
a ratchet, a self-test. A specific gate diagnostic is not flaky
infrastructure. Read the `raw` line, open the workflow step that runs the
check to learn the rule, and fix the offending source. A finding written to
[M1](https://github.com/jig-harness/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md)'s
rules names its rule, its file and line, and its fix (`fix:` on the next log
line, `Fix:` in the annotation): apply that fix.

A gate that says it **could not check** (its message says so, or the step
exited with status 2) has not judged the code at all: its input was missing,
empty or unreadable, or a command it needs failed. Fix the input or the
environment it names (a moved folder, a missing file, an absent merge base
in a shallow checkout), not the code under check, and never read it as a
pass or as a list of findings.

### process_exit (priority 7)

`##[error]Process completed with exit code <n>.` says only that a step
exited nonzero. It accompanies a failed gate and an infrastructure failure (a
timeout, a lost runner, a network error) alike, so it proves neither. Each
exiting step gets its own entry. When no other entry has the same `job` and
`step`, the step printed no specific diagnostic: fetch that job's full log
(Step 0) and find why the step exited: a check that failed without
printing an annotation is a code fix; a runner, network or service failure is
`CI_INFRA`.

## Step 3: Verify locally

Run the same checks CI runs. The validation plan for the branch's whole diff
says which:

```bash
bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/round-plan.ts"
```

It runs `drive.validation_plan_command` with the changed files when the
repository sets one, and otherwise prints the single local check
`gates.command`. Run every local and verification check it prints; follow
what it says about a remote test box; and before committing, run every skill
on its `Mandatory review skills:` line (a migration, an API contract or
another surface with its own review). If neither value is configured, it says
so: run the checks the repository's instruction file names instead.

The plan is a floor. If the original errors included test failures and the
plan does not run the tests, run them too.

If any check fails:

- run `bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" --log "<saved output>"` on the failing output, or read it
  directly, to categorize what remains;
- fix it;
- verify again;
- at most 10 iterations.

If you cannot reproduce the failure locally at all, say so plainly; do not
push speculative fixes. This differs from `CI_INFRA` below (no errors found):
here errors were parsed but the local checks do not show them.

## Step 4: Commit and push

Once every check passes, write the commit message to `ci-fix-message.txt`
with the file-writing tool. Include the run ID, what changed and which local
checks passed. Keep generated summaries as literal file content.

Stage only the files this repair changed or regenerated, by name. Never
stage the whole checkout with `git add` using `-A` or the `.` path: that
would also commit unrelated work in the
checkout. Check `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git status --short` afterwards for anything left out.

```bash
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git add -- <each file this repair changed or regenerated>
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git commit -F ci-fix-message.txt
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git clean -f -- ci-fix-message.txt
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --timeout-seconds 3600 -- git push
```

Remove the message file only after the commit succeeds, so a refused commit
can be retried with it; left behind, it makes the worktree dirty.

Add the co-author trailer your repository uses for agent commits, if any.

## Exit conditions

- **Success**: every local check passes, committed and pushed.
  → `CI_FIXED: All <N> errors resolved and pushed`
- **Partial**: errors remain after 10 iterations.
  → `CI_PARTIAL: Fixed <N>/<M> errors. Remaining: <list>`
- **Infrastructure**: no code errors found (at most a `process_exit` whose
  step failed for an infrastructure reason).
  → `CI_INFRA: No code errors - likely infrastructure/flaky issue`

Whichever applies, report the errors you fixed, those you could not reproduce,
and the green output of the previously failing check. If a fix needed a
non-obvious decision (for example regenerating a contract rather than patching
its consumer), say which and why.

## Session limits

- **Maximum iterations**: 10.
- **Stuck detection**: if the same error appears 3 times, try a different
  approach or skip it.

## Key rules

- Activate the repository's tool version manager, if it uses one, before its
  commands.
- Never use `any` to make a type error go away; use `unknown` and a type
  guard.
- Follow the repository's own coding standards (its instruction file and
  decision records) in every fix.
- Regenerate generated files with their command; never edit them by hand.
- Attribute a test failure before fixing it: a test the diff did not touch
  is reproduced on a freshly fetched base with `probe-base.ts`, never with
  `git stash` or a checkout of the base in the working tree.
- Never pass `--no-verify` or `--no-gpg-sign` to a commit: if a hook fails,
  fix what it found.
- **CI not starting after a push?** Check `mergeable_state` first (Step 0).
  No empty commits until it is `clean` or `unstable`.

## Related skills

- `/jig:github-actions` reviews workflow changes; use it when the fix
  touches `.github/workflows/` or `.github/actions/`.
- `/jig:drive-pr` drives a pull request through review rounds; its
  `round-plan.ts` is the plan Step 3 runs.
