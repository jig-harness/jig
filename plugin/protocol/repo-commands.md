# Commands a repository supplies

Version 1 · stable

Some of Jig's work depends on what only the repository knows: how to run
its checks, which checks a change needs, its own rules for starting an item,
where its [CI](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (continuous integration) service keeps a log. The repository supplies each as a
command in a setting of its `.config/jig.yaml`, and Jig runs it. This
chapter is for the person or program that writes such a command: what
Jig gives it, what Jig reads back, and how long it may take.

Each is one command line for the platform's shell (`sh` on Linux and
macOS, `cmd.exe` on Windows), except where the second table says Jig runs
it without one; it runs from the repository root unless
its row says otherwise. A script of the skill runs some of them, and the
skill's agent runs the others as one of its steps. Exit 0 is success. An exit the third table below lists means
what its row says; any other exit, a command that cannot start, or one
still running past its deadline is a failure, which the caller reports and
never reads as success.

A command under the **command store's rules** is held to more, since a
claim or a CI repair runs it without a person watching: its text is read
from `.config/jig.yaml` as the default branch holds it (fetched first, else
the last fetched copy), never from another branch's working tree, a user's
file or an environment variable; it runs without the tracker and
[forge](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) tokens in its environment; and more than 64 KiB of standard output fails
the run. That is not containment: it runs as the same user, so what bounds
it is the review of the default branch that names it.

Each setting, its default and what a skill does without it:
[the configuration reference](../CONFIGURATION.md); how to write one:
[EXTENDING.md § Commands a repository supplies](../EXTENDING.md#commands-a-repository-supplies).
The same values, for a program in any language:
[data/repo-commands.json](data/repo-commands.json).

## The commands

A deadline is the caller's default, which the named environment variable
or setting changes; a dash means the caller sets no deadline of its own, and the
command runs as long as the step that runs it lets it.

<!-- protocol:generated source=plugin/shared/repo-commands.ts#REPO_COMMANDS -->

| Setting | Run by | Command store's rules | Deadline | Meaning |
| --- | --- | --- | --- | --- |
| `gates.command` | resolve-review-comments, drive-pr, fix-ci, resolve-conflicts, descar | no | — | The repository's local checks, run before every push: all of them, except in a session its dispatcher starts, where `gates.dispatch_fast` may leave some to CI. resolve-review-comments refuses to start without it, and it is drive-pr's one local check where `drive.validation_plan_command` is not set. |
| `drive.validation_plan_command` | drive-pr, fix-ci, resolve-conflicts, review, descar | no | — | Says which checks and reviews a change needs. The change-areas skill's resolver prints such a plan from the change-area catalog. |
| `drive.load_guard_command` | drive-pr | no | — | Waits until the machine can take a round's heavy checks. |
| `drive.dependency_install` | drive-pr, resolve-conflicts | no | 1200 s (`fixed per merge`) | Overrides the frozen dependency install command for a recognized lockfile. A drive round reads overrides from its trusted policy. |
| `ci.log_command` | fix-ci | yes | 300 s (`JIG_FIX_CI_LOG_COMMAND_TIMEOUT_SEC`) | Reads the failed log of a commit status, for a CI service that reports as commit statuses and keeps its logs where only the repository knows how to reach them. |
| `do_item.preflight_command` | do-item, work-batch, dispatch | yes | 60 s (`JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC`) | The repository's own start rules, run by every claim of an item: by do-item, by work-batch for each member, and by a dispatched pickup. |
| `followup.arms` | followup | yes | 60 s (`JIG_FOLLOWUP_CHECK_TIMEOUT_SEC`) | A repository's own follow-up arm, read-only: says whether a merge owes what that arm checks. The followup skill records its verdict through the same ledger as every other arm. |
| `descar.lint_command` | descar | no | — | Finds review scars in documents. |
| `promote_memory.lint_command` | promote-memory | no | — | Checks one agent memory against the repository. |
| `fix_ci.regenerate_commands` | fix-ci | no | — | Each regenerates committed generated files a CI check compares; a list of commands. |
| `resolve_conflicts.generated` | resolve-conflicts | no | — | Rebuilds files that are regenerated, never merged by hand, when they conflict; each entry pairs `paths` with the `command` that rebuilds them. |
| `resolve_conflicts.sequenced_migrations` | resolve-conflicts | no | — | Rebuilds the sequenced migration journal and snapshots after the sides' migrations are combined. |
| `explain.figure_build_command` | explain | no | — | Builds one explainer figure. |
| `reflection.command` | reflect, review-reflections, dispatch | no | 120 s (`reflection.timeout_sec`) | The reflection store, where `reflection.store` is `command`: it keeps the findings sessions record with the reflect skill. |
| `changelog.after_version` | changelog | no | 1800 s (`JIG_AFTER_VERSION_TIMEOUT_SEC`) | Updates the files that repeat the version, such as a lock file, for the release commit. |
| `code_stats.classify_command` | code-stats | no | 300 s (`JIG_CODE_STATS_COMMAND_TIMEOUT_SEC`) | The last layer of code-stats' classification of the repository's files. |

<!-- /protocol:generated -->

## What each is given, and what it answers with

<!-- protocol:generated source=plugin/shared/repo-commands.ts#REPO_COMMANDS -->

| Setting | Through a shell | Given | Answers with |
| --- | --- | --- | --- |
| `gates.command` | yes | Nothing: it runs from the repository root, in the working tree being changed. | Exit 0 when every local check the repository runs in this session passes. A repository may run fewer in a session its dispatcher starts, as `gates.dispatch_fast` describes, and leave the rest to CI. |
| `drive.validation_plan_command` | yes | The changed files on standard input, one path per line. | Exit 0 and the validation plan as one JSON object on standard output; a nonzero exit or output that is not a JSON object is reported apart from a plan. |
| `drive.load_guard_command` | yes | Nothing: it runs from the repository root before a round's heavy checks. | Exit 0 once the machine can take the checks; any other exit is a warning that the round's heavy checks may be refused. |
| `drive.dependency_install` | yes | Nothing on standard input. Each command runs in its lockfile's directory in the merged worktree. | Exit 0 when the pinned dependencies are available without changing the dependency inputs. Any other exit stops the round before validation. |
| `ci.log_command` | yes | One JSON object, `{"context", "target_url"}`, the failing commit status's context and the page it links to (null when it links to none), on standard input. It runs in a temporary copy of the default branch's files, not in the pull request's working tree. | Exit 0 and the status's failed log on standard output, at most 64 KiB of it. |
| `do_item.preflight_command` | yes | The item's JSON, as `get_issue.ts` prints it, on standard input. It runs from the repository root before a claim takes its lock or writes anything. | Exit 0 lets the claim go on. |
| `followup.arms` | yes | The follow-up's merge facts as one JSON object on standard input (`followup.ts facts` prints the same object). Each entry's `check_command` runs from the repository root, as the integration branch's configuration names it. | Exit 0 and one verdict JSON object on standard output, `{"verdict": "owed"\|"not-owed"\|"pending"\|"unread", "items": [...], "evidence": "..."}`, at most 64 KiB. A run past its deadline, any other exit, or output that is not such an object records the arm `unread` with the reason, never `not-owed`. |
| `descar.lint_command` | yes | The paths of the documents to check, as arguments. | The scars it finds, which descar's steps read. |
| `promote_memory.lint_command` | yes | The command line with `{dir}` and `{file}` replaced by the memory's folder and file. | Exit 0 when the memory is clean. |
| `fix_ci.regenerate_commands` | yes | Nothing: each runs from the repository root. | Exit 0 once it has rewritten its generated files. |
| `resolve_conflicts.generated` | yes | Nothing: each entry's `command` runs from the repository root. | Exit 0 once it has rebuilt the files its entry's `paths` match. |
| `resolve_conflicts.sequenced_migrations` | yes | Runs from the repository root after the planned migration source files and integration metadata are in place. Standard input is migration-plan.ts JSON, with an entry for each directory and its regenerate paths. | Exit 0 once the journal and required snapshots are rebuilt and integration snapshots are preserved. |
| `explain.figure_build_command` | yes | The command line with the figure's stem appended. | Exit 0 once the figure is built beside its diagram source. |
| `reflection.command` | no | A command line split into words, or a list of words, run without a shell, with the operation appended: `check`, `append` (the findings as JSON Lines on standard input), `list` (an optional `{"since"}` object on standard input) or `diagnose`. `list` and `diagnose` get five times the deadline, since they read the whole store. | Exit 0 and the operation's answer as JSON or JSON Lines on standard output, as the reflect skill's store contract says; its conformance suite checks a store command against it. |
| `changelog.after_version` | yes | Nothing: it runs from the repository root after the release step changes the version and before it deletes the change notes. Inside a CI job the release refuses to run it unless the job sets `JIG_AFTER_VERSION_IN_CI=1`. | Exit 0, leaving no process it started running. Its standard output is not read, only shown on standard error; the files it changed go into the release commit. |
| `code_stats.classify_command` | yes | Every tracked path on standard input, one per line; it runs once, from the repository root. | Exit 0 and one JSON object per line, `{"path", "area"?, "kind"?, "language"?, "module"?}`, whose values override the skill's own classification. A line it cannot use, an untracked path, or an unknown area or kind fails the report. |

<!-- /protocol:generated -->

## Exits besides 0 a caller reads

<!-- protocol:generated source=plugin/shared/repo-commands.ts#REPO_COMMANDS -->

| Setting | Exit | Meaning |
| --- | --- | --- |
| `ci.log_command` | 3 | The log is gone (the build was deleted or its log rotated away); the first line of standard output is the reason. |
| `do_item.preflight_command` | 3 | Refuses the claim: nothing is written, the claim exits 3 with `"why": "preflight"`, and the first line of standard output is the reason. Any other failure refuses it too. |
| `reflection.command` | 3 | The store is unavailable (unreachable, or not signed in): reflect keeps the findings in its journal rather than failing. A run past its deadline, or one that cannot start, is read the same way. |

<!-- /protocol:generated -->

## JSON Schemas

Schemas describe the output a caller reads: a
[validation plan](schemas/validation-plan.json), one
[classification line](schemas/classify-output.json), and the reflection
store responses for [check](schemas/reflection-check.json),
[append](schemas/reflection-append.json),
[diagnose](schemas/reflection-diagnose.json) and each
[list event](schemas/reflection-event.json). A stream carries one matching
JSON document per line where its command contract specifies JSON lines.
