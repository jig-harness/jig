# Applied migrations never change

Part of [M15 Contracts and error handling](../../README.md).

Once a migration file is on the branch a change merges into, some
environment has applied it, and the runner there recorded the file's hash
when it did. An edit to that file makes the environment refuse every later
migration; a rename or a deletion leaves the runner with a ledger entry and
no file to check it against. The fix for a wrong migration is a new one
([fix forward](../../../../GLOSSARY.md)), never a changed one.

`check-no-migration-edits.ts` is the merge-time half of that rule: it fails
a change that modifies, renames or deletes a migration file that the base
branch already holds. The apply-time half, the runner refusing a file whose
hash differs from the one it recorded, is each migration tool's
([mappings](../../mappings.md#migration-discipline)).

## Usage

```bash
bun check-no-migration-edits.ts --base origin/main [--head HEAD] [--repo .] [--match '\.sql$'] db/migrations
```

- `--base` — the branch the change merges into; required.
- `--head` — the commit under check; default `HEAD`.
- `--repo` — the repository; default the working directory.
- `--match` — which paths under the directory are migration files, an
  extended regular expression; default `\.sql$`. The ledger and the
  snapshots beside the files are metadata that a new migration edits, so
  they do not match.
- The migrations directory, relative to the repository or absolute.

The gate reads git only (the trees of the merge base, the head and the base
branch's history), never the working tree, so it checks the same thing in a
pre-push hook and in CI. It imports `lib/cli.ts`, `lib/findings.ts` and
`plugin/shared/guarded-git-spawn.ts` from the Jig repository, so run it from
a pinned Jig checkout or vendor those three files with it.

## The rule

The files that changed between the merge base of `--base` and `--head` and
the head are listed; each that matches `--match` and was modified, deleted,
renamed or changed type is a finding, with one exception. A modification is
allowed when the head's content, mode and bytes, is a state the path held in
some commit of the base branch: that restores an earlier illegal edit, and
is exactly what makes the apply-time check pass again. Novel content is
never allowed, a deletion or a rename never, and a file that became a link
to the same text never (the blob is the same, the mode is not). Files added
on the head are not checked: nothing has applied them, and an edit to one on
the same branch is still an addition.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | No applied migration under the directory changed | `OK — <n> applied migration(s) under <dir> unchanged …; <k> added` |
| 1 | At least one did | one finding per file: the path, what happened, and the remedy |
| 2 | Could not check | a message on standard error |

The gate fails closed: a `--base` or `--head` that names no commit, two
commits with no merge base, a `--repo` git cannot read, a directory outside
the repository, a directory with no matching file at either the merge base
or the head (the path is probably wrong), a `--match` that is not a regular
expression, or a bad option exits 2, never 0.

## Wiring

Run it in CI on every pull request against the target branch, and in the
pre-push hook against the branch the work merges into:

```yaml
- run: git fetch --no-tags origin main
- run: bun <jig>/modules/M15-contracts-errors/reference/migration-immutability/check-no-migration-edits.ts --base origin/main db/migrations
```

A migration that must change after all (it never applied anywhere) is
handled by resetting the environments that never ran it and adding the
change as a new file, not by editing: the gate cannot tell an environment
that applied the file from one that did not, and treats every merged file
as applied.

## Fixtures and the self-test

`fixtures/` holds the migration files the self-test commits into scratch
repositories: the applied state, an illegal edit, a second edit, a new
migration, a migration in another language and a ledger. The test builds a
repository per scenario (`main` with the applied files, `feature` with the
change, `main` moved on where the case needs it), runs the gate against
`feature`, and checks the exit code, the findings and the pass line for
every outcome. Run it from a Jig checkout with
`bun test ./migration-immutability.test.ts`.
