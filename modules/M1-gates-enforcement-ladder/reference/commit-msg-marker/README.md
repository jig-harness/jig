# Commit-msg review marker

Some changes must pass a mandatory review step — a database migration
reviewed by an architect, a security-sensitive file signed off by its owner.
The problem: nothing in git records that the review happened, so nothing can
enforce it. This piece closes the gap with a **process marker**: a literal
tag (e.g. `[reviewed:db-migration]`) that the committer adds to the
commit-message body once the review is done, checked by a commit-msg hook
whenever protected files are staged — and re-checked by a later gate (CI)
so the local hook is a convenience, not the authority.

`check-review-marker.sh` is the portable hook script (bash + grep + git; no
runtime). Wire it into your hook manager's `commit-msg` hook — see
`../../templates/lefthook.yml` for placement and `../../mappings.md` for
husky / pre-commit-framework equivalents.

## Design notes (why it is built this way)

- **Why commit-msg, not pre-commit.** The commit-message file is only
  populated *after* pre-commit succeeds. A pre-commit hook reading it would
  always see a stale or missing message and reject every protected commit.
  commit-msg is the first hook that reliably sees the message the user
  actually wrote; the hook manager passes the message file path as an
  argument (lefthook: `{1}`, husky/raw git: `$1`).
- **Why a message-body tag, not git notes.** Git notes do not propagate
  through `git push` by default, so CI and other clones would never see the
  sign-off. A body tag travels with the commit everywhere, is greppable
  (`git log --grep`), and survives rebases that preserve the message.
- **Belt and suspenders.** The primary mechanism should be your review
  workflow itself (the reviewing agent or checklist adds the tag). The hook
  catches the bypass cases — direct commits, amends, an unfamiliar agent —
  and a CI-side re-check of commit messages on the PR closes the
  `--no-verify` hole. Which rung re-checks is your choice; the invariant is
  that at least one rung the committer cannot skip verifies the marker.
- **Scope discipline.** The hook exits 0 immediately when no protected file
  is staged, so unrelated commits pay nothing. Keep `REVIEW_PATHS_RE`
  narrow; a marker demanded too broadly gets pasted reflexively and stops
  meaning "reviewed".

Markers are suppression-adjacent: each marker tag deserves a row in your
suppression-token registry (`../../templates/suppression-registry.md`) so
its syntax, consuming gate, and justification requirement are discoverable.

## Trying it locally

```sh
cd "$(mktemp -d)" && git init -q .
mkdir -p db/migrations && echo 'CREATE TABLE t (id INT);' > db/migrations/0001.sql
git add db/migrations/0001.sql
echo 'feat: add table t' > MSG
path/to/check-review-marker.sh MSG           # fails: marker missing
printf 'feat: add table t\n\n[reviewed:db-migration]\n' > MSG
path/to/check-review-marker.sh MSG           # passes
```
