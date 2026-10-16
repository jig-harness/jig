# Database migrations

> Copy this beside your migrations (e.g. `db/migrations/AGENTS.md` or
> `docs/development/migrations.md`), fill in the placeholders, delete what
> does not apply, and point your agent instruction file at it. It is the
> migration half of the contract in Jig's
> [M15 contracts and error handling](https://github.com/docomply/jig/blob/main/modules/M15-contracts-errors/README.md);
> the checks per migration tool and the parser per database are in its
> [mappings](https://github.com/docomply/jig/blob/main/modules/M15-contracts-errors/mappings.md#migration-discipline).
> Terms are defined in Jig's
> [glossary](https://github.com/docomply/jig/blob/main/GLOSSARY.md).

## Where and how

Migrations live in `<db/migrations/>` and run with `<bun db:migrate up>`
(`<the tool and its command>`). A migration is one file,
`<NNNN_descriptive_name.sql>`, written by hand, and its entry in the ledger
(`<the tool's journal, changelog or revision chain>`) lands in the same
commit, its order key one past the current highest and every field the
runner reads explicit; the fields per tool are in the
[mappings](https://github.com/docomply/jig/blob/main/modules/M15-contracts-errors/mappings.md#migration-discipline).
The runner records each file's hash when it applies it.

Before writing a migration with a statement the database will not run inside
a transaction, read `<the runner-semantics page>`: it says how the runner
wraps what it applies and which statements need their own path.

## The rules

1. **Immutable once merged.** A migration that has merged is never edited,
   renamed or deleted; it is presumed applied to some environment, and the
   runner there recorded its hash. A wrong migration is corrected by a new
   one that makes the change (fix forward). When the merge-time gate fails:
   restore the file to the content `<main>` holds and put the change in a
   new migration; an environment that never applied the file is reset
   instead. The one edit the gate allows is a restoration to content the
   file held before on `<main>`, which is what repairs an earlier illegal
   edit.
2. **Structure only.** A migration changes tables, columns, indexes,
   constraints, functions and policies, never rows. Seed data goes in
   `<db/seeds/>`; a backfill is a job in `<src/jobs/backfills/>` with its
   own runtime, locking and rollback. A data change that must ride in a
   migration needs an entry in `<db/migration-data-allowlist.txt>` naming the
   file and the statement, under the reviewer's reason, approved by
   `<the migration reviewer>`; the check parses the SQL and finds a data
   statement wherever it sits, a `DO` block, a function body or a `WITH`
   query included, and fails a file whose dynamic SQL it cannot read.
3. **The ledger and the files match.** Every file has its entry and every
   entry its file; the order keys strictly increase, with no gap; a ledger
   check holds this in CI, because the runner applies what comes after the
   last applied entry and would skip an entry behind it without a word.
4. **Reviewed before it lands.** Every commit that touches
   `<db/migrations/>` carries `<[reviewed:db-migration]>` in its message
   body, written after `<the review the marker attests: a second reviewer,
   a review agent, a checklist>`; the commit-msg hook refuses the commit
   without it and CI re-checks the pull request's commits.

## The checks

| Rule | Check | Where it runs |
|------|-------|---------------|
| Immutable once merged, at merge time | `<scripts/check-no-migration-edits.ts --base origin/main db/migrations>` (Jig's [reference gate](https://github.com/docomply/jig/blob/main/modules/M15-contracts-errors/reference/migration-immutability/README.md)) | pre-push; CI on every pull request |
| Immutable once applied, at apply time | `<the runner's own validation, or the wrapper's hash check>` | every `<db:migrate up>` and `<db:migrate status>`, in every environment |
| The ledger and the files match | `<scripts/check-migration-ledger.ts>` | pre-push; CI |
| Structure only | `<scripts/check-migrations-structure-only.ts>` over `<db/migrations/>` with `<db/migration-data-allowlist.txt>` | pre-push; CI |
| Reviewed before it lands | `<the commit-msg marker hook>` on `<db/migrations/>`; CI re-checks the marker | commit-msg; CI |

Each check has three outcomes: pass, findings, and could not check (a
missing directory, an unreadable ledger, a file the parser cannot read),
which fails the gate like a finding does.

## Writing one

- [ ] The file name follows `<NNNN_descriptive_name.sql>` and its ledger
      entry is in the same commit, every field explicit.
- [ ] Structure only; any data statement is allowlisted with a reason, or
      moved to a seed or a job.
- [ ] `<Your repository's structural rules for every table: the columns,
      keys and indexes each one carries, and the exceptions listed by name.>`
- [ ] The commit message carries `<[reviewed:db-migration]>` after the review.
