---
name: fix-ci
description: "Fix a failing CI run on a branch or pull request: parse the failed run's log, fix every error in priority order, verify locally, then commit and push."
argument-hint: "[run-id | #PR | --pr <number> | --branch <name>]"
context: fork
allowed-tools: "Read Edit Write Grep Glob Bash(gh run *) Bash(gh pr *) Bash(gh api *) Bash(git *) Bash(bun *)"
---

# Fix CI errors

Fix every error from a failed GitHub Actions run until the local checks pass,
then commit and push. CI ([continuous integration](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) is
the service that runs the repository's checks on every push; this skill turns
its red run into a green one without guessing. The checks it repairs are the
repository's quality gates, the subject of Jig module
[M1 (gates & enforcement ladder)](https://github.com/docomply/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md).

Jig maintains this procedure and ships it in the `jig` plugin.
Each repository supplies its own values in `.config/jig.yaml`
(the [consumer overlay](https://github.com/docomply/jig/blob/main/GLOSSARY.md)); every value this skill reads
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
[mise](https://github.com/docomply/jig/blob/main/GLOSSARY.md)), make sure it is active in the shell before you
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

## Step 0: Parse the CI errors

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/consumer-config.ts"
bun "${CLAUDE_SKILL_DIR}/scripts/parse-ci-log.ts" $ARGUMENTS
```

Read the JSON. If `errors_found` is 0:

- `"error": "no_failed_runs"`: report that no failed run was found.
- The run failed but no error was parsed: fetch the raw log with
  `gh run view <RUN_ID> --log-failed` and investigate.

> **Cancelled, not broken?** Check the run's conclusion and its jobs'
> annotations before analyzing code. A job's ID is also the ID of its check
> run, which holds the annotations:
>
> ```bash
> gh run view <RUN_ID> --json conclusion --jq '.conclusion'
> gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion!="success") | {databaseId, name, conclusion}'
> gh api repos/{owner}/{repo}/check-runs/<JOB_ID>/annotations --jq '.[].message'
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
> gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {databaseId, name}'
> gh run view --job <JOB_ID> --log | grep -E 'FATAL|UnhandledRejection|Error:|verification failed' -B2 -A20
> # Only when a run actually uploaded a log artifact (rare):
> gh api repos/{owner}/{repo}/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[].name'
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
> gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {databaseId, name}'
> gh run view --job <JOB_ID> --log | grep -E '<failing-package>|FAIL|Error:' -B 2 -A 20
> ```
>
> **CI never started after a push?** Check the pull request's merge state
> first:
>
> ```bash
> gh api repos/{owner}/{repo}/pulls/<PR_NUMBER> --jq '.mergeable_state'
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
the harness's task list (Claude Code: `TaskCreate`).

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
`<x>:check`. [M2 (generated-artifact freshness)](https://github.com/docomply/jig/blob/main/modules/M2-generated-artifact-freshness/README.md)
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
preference, not an either-or. For failures that predate the current change
and are unrelated to it, follow the repository's own stale-test triage
procedure, if it has one.

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

A check written for this repository failed: a [grep gate](https://github.com/docomply/jig/blob/main/GLOSSARY.md),
a ratchet, a self-test. A specific gate diagnostic is not flaky
infrastructure. Read the `raw` line, open the workflow step that runs the
check to learn the rule, and fix the offending source. A finding written to
[M1](https://github.com/docomply/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md)'s
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

- run `parse-ci-log.ts --log <saved output>` on the failing output, or read it
  directly, to categorize what remains;
- fix it;
- verify again;
- at most 10 iterations.

If you cannot reproduce the failure locally at all, say so plainly; do not
push speculative fixes. This differs from `CI_INFRA` below (no errors found):
here errors were parsed but the local checks do not show them.

## Step 4: Commit and push

Once every check passes, write the commit message to a file first (the Write
tool, or a quoted heredoc: `<<'EOF'`, never `<<EOF`) rather than
interpolating the generated summary into `-m "..."`. Inside double quotes the
shell expands backticks and `$(...)`, so a message that quotes code can run
it.

Stage only the files this repair changed or regenerated, by name. Never
`git add -A` or `git add .`: they would also commit unrelated work in the
checkout. Check `git status --short` afterwards for anything left out.

```bash
git add -- <each file this repair changed or regenerated>
commit_message_file=$(mktemp)
trap 'rm -f "$commit_message_file"' EXIT
cat > "$commit_message_file" <<'EOF'
fix: resolve CI errors from run #<RUN_ID>

- Fixed: <summary of categories and counts>
- Verified: <the checks that passed locally>
EOF

git commit -F "$commit_message_file" && rm -f "$commit_message_file"

git push
```

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
- Never pass `--no-verify` or `--no-gpg-sign` to a commit: if a hook fails,
  fix what it found.
- **CI not starting after a push?** Check `mergeable_state` first (Step 0).
  No empty commits until it is `clean` or `unstable`.

## Related skills

- `/jig:github-actions` reviews workflow changes; use it when the fix
  touches `.github/workflows/` or `.github/actions/`.
- `/jig:drive-pr` drives a pull request through review rounds; its
  `round-plan.ts` is the plan Step 3 runs.
