# Resolve conflicts

Run these commands in Bash or PowerShell with Bun and Git available to the
command tool. The shared command runner writes the checked commit message to
a file only after validation succeeds; commit that file after the command
exits successfully.

A merge can finish without conflict markers and still lose a change, pick up
another session's staged work, or break a repository rule in a file Git
merged cleanly. `/jig:resolve-conflicts` checks the entire resolution before
the operation is concluded, so reviewers can see what was kept and why.

The skill needs Git 2.41 or newer, to reconstruct the automatic result and to
read attributes from the index. It
handles stopped merges, rebases, cherry-picks and reverts. Picking or reverting
a merge commit with `-m` requires manual resolution and validation; Git does
not reliably retain the selected parent, so the mapper refuses to certify it.
Merge commits recreated by a rebase using `--rebase-merges` are supported. It names
the role of each side, maps the conflicts, regenerates derived files, records
decisions, and checks for dropped changes. The
[agent procedure](SKILL.md) gives the commands and exit codes.

## Staged changes belong to the operation

`check-resolution.ts` checks every staged path against the operation's
changed-file set. Unrelated staged work blocks conclusion, with the path
and remediation in the report. Preserve that work outside the operation;
never discard another session's edits to make the check pass.

For an operation-owned path without a recorded decision, its staged content
must match Git's automatic result. A manual change needs a recorded decision,
even in a file that merged cleanly. Inspect the output of `bun "<skill-dir>/../../shared/command.ts" -- git diff --cached` to confirm the
hunks belong to the resolution. Blob contents, file modes and deletions all
matter; merely appearing on a changed-file list does not establish ownership.

## Repository obligations

Path-specific agent instructions may never load when Git makes an edit.
Declare requirements that must survive every merge in the repository's
configuration:

```yaml
resolve_conflicts:
  obligations:
    - check: "Changed callers still use the shared validation helper."
      command: bun run check:validation
    - check: "The resolved diff preserves each side's documented error handling."
```

The agent checks each obligation against the **whole staged diff**, including
auto-merged files and hunks, and includes the evidence and outcome in its
resolution report. Optional commands run from the repository root with a
deadline; failures block conclusion. Commands read files on disk, so each one
runs only while every tracked file matches the staged tree, checked before
every command and after the last. Submodules are compared whatever their
ignore settings, and files Git is told not to compare (assume-unchanged or
skip-worktree) are compared too, including those inside initialized
submodules. A command that changes the staged tree
or a tracked file stops the commands after it and invalidates the whole run:
review the change, stage or discard it, and check again. A passing command supplements the text
review. With no obligations configured, there are none to run.

See [configuration](../../CONFIGURATION.md#procedure-skills) for field details.

## Where past merges conflicted

`scripts/history.ts` replays the merge commits of a range of time (the last
30 days by default) with `git merge-tree`, which changes nothing in the
repository, and reports the paths that conflicted most often, a cause for
each conflicting region (a lockfile, a release version, a count, a list
every change adds to, two changes to the same lines, …), the change that
removes each cause, the
[conflict hotspots](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
and a weekly trend, as text or as `merge-conflicts/v1` JSON. It needs Git 2.43
or newer, skips the merges a shallow clone cuts, and says how often each
cause was right when a sample was checked by hand. The
[agent procedure](SKILL.md#where-past-merges-conflicted-the-history-report)
has the flags and the causes.

## What each resolution leaves

The snapshot of an operation is overwritten by the next one, so a rebase that
stops five times kept only its last stop. `scripts/events.ts` runs after an
operation concludes (the skill's Step 7 does it) and appends one line per
conflicted path to `conflict-events.jsonl` in git's common directory: the
operation, the path, why it conflicted, the decision and reason, how long
the resolution took, and whether a `drive-pr` conflict-resolve round started
it. Every worktree of the clone shares the file and nothing commits it. It
covers the rebases, cherry-picks and reverts that
`history.ts` cannot replay. The
[agent procedure](SKILL.md#the-live-record) has the fields.

## Verification

The skill's scratch-repository tests exercise unrelated staging during merges
and rebases, merge-commit replay, automatic and manual changes, and repository
obligations. The plugin-copy test runs the procedure from a cache outside this
repository, without installed dependencies.
