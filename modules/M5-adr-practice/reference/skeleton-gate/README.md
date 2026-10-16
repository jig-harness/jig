# Skeleton-file gate

Part of [M5 ADR practice](../../README.md).

**What problem this solves.** Some files hold the architecture's contracts:
the layer rules, the published interfaces, the schema of record. An agent
that is told to "make the tests pass" will change any file that stands in its
way, including a contract, and the change looks like any other diff. By the
time a person notices, other code already depends on the new shape. This
gate makes such a file expensive to change by accident: the change must
carry recorded authority, or it does not merge.

`check-skeleton-adr.ts` reads the [skeleton inventory](../../templates/skeleton.yaml)
and fails a change that touches a [skeleton file](../../../../GLOSSARY.md)
without that authority. It checks only; it changes nothing.

## Invariant

> A change to a skeleton file merges only with recorded authority: it edits
> the inventory, or a commit trailer names an approved decision record. The
> gate fails closed: on an inventory entry that matches no file (stale, or a
> skeleton file renamed away), on a record that does not resolve or is not
> approved, and on input it cannot read.

## Usage

```bash
bun check-skeleton-adr.ts [--inventory <file>] <commit-msg-file>
bun check-skeleton-adr.ts [--inventory <file>] --base <ref> --head <ref>
```

| Form | Reads | Use |
|------|-------|-----|
| `<commit-msg-file>` | the staged change, the index and the message | a `commit-msg` hook |
| `--base <ref> --head <ref>` | the diff `base...head`, every message in `base..head`, the tree at `head` | CI, on a pull request: the authority a person cannot skip with `--no-verify` |

`--inventory` defaults to `.config/skeleton.yaml`. An inventory entry gives
`path` (literal: a file, or a directory with a trailing `/`) or `glob` (a
pattern), never both: a literal path such as `app/[id]/page.tsx` must not also
match `app/i/page.tsx` as a pattern would. The inventory is read from
the tree being checked (the index, or `head`), never from the working
directory, so an unstaged edit authorizes nothing.

The range form treats a pull request as one change: a trailer on any of its
commits authorizes the range, so a fix-up commit does not need its own, and a
squash merge that keeps the trailer stays valid.

Exit codes follow [M1](../../../M1-gates-enforcement-ladder/README.md)'s three
outcomes: `0` passed, `1` violations (each names the rule, the problem and the
fix), `2` could not check (no inventory, an inventory that lists nothing or
lacks a `why`, a git failure, bad usage).

## What it checks

| Rule | Fails when |
|------|------------|
| `skeleton-change-unauthorized` | a skeleton file is added, changed or deleted, the inventory is not edited in the same change, and no commit names a record |
| `skeleton-record-not-approved` | a named record is malformed (`../ADR-1`), does not resolve to exactly one file under `decision_records`, has no readable `status`, is superseded, has a `superseded_by` that is neither a record id nor null, or its status is not in `approved_statuses` (a draft or deprecated record authorizes nothing) |
| `skeleton-inventory-stale` | an inventory entry matches no file in the tree: the file was renamed, moved or deleted without updating the list |
| `skeleton-file-moved-out` | git detects a skeleton file renamed to a path no inventory entry covers (a file leaving a listed directory), and the inventory is not edited: the file would silently stop being protected |

The stale check runs on every commit, not only on one that touches a skeleton
file. A rename of a file listed by its exact path is therefore never
authorized by a trailer alone: the listed path no longer exists, so the
inventory edit is what makes the change whole. A file renamed out of a listed
directory or glob leaves the directory non-empty, so staleness cannot see it;
the moved-out rule does, from git's rename detection. A move git does not
detect as a rename (a large edit with it) still shows as the deletion of a
skeleton path, which needs authority, but the new path is then not checked.

A trailer is a `Decision-Record: ADR-NNNN` line in the message's last
paragraph (the key is case-insensitive). Every record named must be valid:
one approved record next to a draft one still fails.

## Design notes

- **Extends the commit-msg marker.** The mechanism is
  [M1's commit-msg marker](../../../M1-gates-enforcement-ladder/reference/commit-msg-marker/README.md)
  with two limits of a bare tag lifted. The protected set comes from an
  inventory instead of one regular expression, so it can be reviewed, owned
  and checked for staleness; and the tag names a record that is resolved and
  read, so a malformed, missing, draft or superseded record authorizes
  nothing. The body trailer is used for the same reason as there: it travels
  with the commit through pushes and rebases, which git notes do not.
- **Two rungs.** The hook is a convenience; the CI form is the authority, as
  for every marker. The CI form runs the gate from a pinned Jig checkout, in
  a job of its own that runs none of the change's code first, with Bun's
  configuration and `.env` loading pinned away from the checkout under
  review: a change that could reach the gate's code, its runtime or the refs
  it reads could make it pass without authority
  ([mappings](../../mappings.md#github-actions)).
- **Where it runs from.** The gate imports the shared `lib/` helpers and the
  YAML parser vendored under `lib/vendor/` by paths relative to its own file
  (`../../../../lib/`), so it runs from a Jig checkout pinned to one commit,
  which is what the [mappings](../../mappings.md) recipes do. A vendored copy
  keeps that layout: `lib/` and this directory at
  `modules/M5-adr-practice/reference/skeleton-gate/` under one root. The
  gate then needs nothing installed; the self-test also imports
  `plugin/shared/`, so it runs in Jig's own checks.
- **Which record.** The gate checks that the record named is approved, not
  that it covers the files changed: that match is what a reviewer reads. A
  record is read from the change's own tree, so a record added and approved in
  the same change counts; see the next point.
- **Whose approval.** The gate reads the record's `status`; it cannot tell
  who set it. Without a code-owners rule or required reviewer on the
  decision-record directory and on the inventory, an author who may edit
  both can authorize their own change. Treat those two paths as skeleton
  files themselves, owned by the people who own the architecture, and give
  the ownership file (`CODEOWNERS`) the same owners, or an earlier change can
  remove the rule
  ([mappings](../../mappings.md#ownership-of-the-two-authority-paths)).
- **What the hook cannot see.** It reads the staged change, so a
  `git commit --amend` that only rewords the message sees nothing of what the
  commit already held, and a merge in progress is skipped (the merge's changes
  were checked on the branch they came from). The CI form reads the whole
  pull request and is the authority for both.
- **Why one authority is an inventory edit.** Adding, renaming or removing an
  entry is itself a change to the list of contracts, which the owners of the
  inventory review; requiring a record for that as well would make every
  rename a two-step process for no added review.
- **Maturity.** The concept (a named set of contract files that only people
  change) is long established where it was observed; this blocking gate is
  young. Adopt it in a repository's pull-request check first, and treat the
  first weeks of findings as feedback on the inventory's breadth: an
  inventory that lists half the repository gets pasted past, as a marker
  demanded too broadly does.

## Trying it locally

```sh
cd "$(mktemp -d)" && git init -q -b main .
mkdir -p .config docs/adr contracts
printf 'skeleton:\n  - path: contracts/\n    why: the public interfaces\n' > .config/skeleton.yaml
printf -- '---\nstatus: approved\n---\n' > docs/adr/ADR-0001-contracts.md
echo 'v1' > contracts/api.txt
git add -A && git commit -qm 'chore: base'
echo 'v2' > contracts/api.txt
git add -A && echo 'feat: api' > MSG
bun path/to/check-skeleton-adr.ts MSG           # fails: no authority
printf 'feat: api\n\nDecision-Record: ADR-0001\n' > MSG
bun path/to/check-skeleton-adr.ts MSG           # passes
```

The self-test is [`check-skeleton-adr.test.ts`](check-skeleton-adr.test.ts): it
builds scratch repositories and covers each rule through the hook form, the
unauthorized, stale, moved-out and inventory-edit cases through the range
form too, the fail-closed inputs and the parsing.
