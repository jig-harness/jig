# Resolve conflicts

A merge can finish without conflict markers and still lose a change, pick up
another session's staged work, or break a repository rule in a file Git
merged cleanly. `/jig:resolve-conflicts` checks the entire resolution before
the operation is concluded, so reviewers can see what was kept and why.

The skill needs Git 2.40 or newer to reconstruct the automatic result. It
handles stopped merges, rebases, cherry-picks and reverts. Picking or reverting
a merge commit with `-m` requires manual resolution and validation; Git does
not reliably retain the selected parent, so the mapper refuses to certify it.
Merge commits recreated by `git rebase --rebase-merges` are supported. It names
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
even in a file that merged cleanly. Inspect `git diff --cached` to confirm the
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
deadline; failures block conclusion. Commands read files on disk, so they run
only when every tracked file matches the staged tree, and a command that
changes the staged tree or a tracked file invalidates the whole run: review
the change, stage or discard it, and check again. A passing command supplements the text
review. With no obligations configured, there are none to run.

See [configuration](../../CONFIGURATION.md#procedure-skills) for field details.

## Verification

The skill's scratch-repository tests exercise unrelated staging during merges
and rebases, merge-commit replay, automatic and manual changes, and repository
obligations. The plugin-copy test runs the procedure from a cache outside this
repository, without installed dependencies.
