# Per-worktree data namespaces

Part of [M12 Parallel-agent ergonomics](../../README.md).

Several worktrees on one machine share one database server. Without a
namespace per worktree, two branches' migrations run over the same tables,
one worktree's reset wipes another's data, and a test that passed alone fails
beside a neighbour. The port allocator's move, applied to data: each worktree
derives its own namespace (a schema, a database, a key prefix) from its
identity, created with an owner and an expiry, and reaped by that owner once
the worktree is gone or the expiry has passed.

The scripts, each self-tested:

- `namespace-for-worktree.ts` — the name a worktree's namespace gets.
- `find-stale-namespaces.ts` — the reaper's decision: which of one owner's
  namespaces to drop, and which were created without the keys a reaper needs.

Both import the command-line boundary (`lib/cli.ts`) from the Jig
repository's `lib/`, and the reaper also `lib/record.ts`, by relative path,
so run them from a pinned Jig checkout or vendor `lib/` with them at the same
place relative to this directory. Run the self-tests with
`bun test ./namespace-for-worktree.test.ts ./find-stale-namespaces.test.ts`.

Neither touches a database. The adapter that creates and drops is a few lines
of the repository's own tooling ([mappings.md](../../mappings.md#per-worktree-data-namespaces)
has them per database); these two decide the names and the plan.

## Naming

```bash
bun namespace-for-worktree.ts [--prefix wt_] [--max-length 63] [<worktree-id>]
```

The identity is the worktree's branch, as `git branch --show-current` prints
it (the argument, or `WORKTREE_ID`). The reaper reads the live worktrees'
branches from `git worktree list` and derives their names by the same rule,
so a namespace named from anything else (a directory name, a hand-set
`WORKTREE_ID`) looks orphaned to it. A detached worktree has no branch, so it
gets no namespace: `git branch --show-current` prints nothing, and an empty
identity is refused.

The identity is lowered, every run of characters outside `a-z` and `0-9`
becomes one underscore, the ends are trimmed of underscores, the prefix goes
in front, and `_` and 16 hex characters (64 bits) of a SHA-256 hash of the
identity as given go at the end: `feature/refunds` is `wt_feature_refunds_190b79a5137797d4`. The same
identity always gets the same name, so no registry is needed and any script
can derive it.

- **The hash keeps apart what the slug merges.** `feature/refunds`,
  `feature-refunds` and `Feature/Refunds` lower to one slug; the hash is of
  the identity before lowering, so each still gets its own namespace. A
  64-bit suffix makes an accidental collision negligible, not impossible, so
  the reaper refuses a live listing in which two branches derive one name
  instead of reading them as one worktree.

- **The prefix is never empty.** The namespace with no prefix is the one
  production uses (`public` in PostgreSQL, the plain database elsewhere). An
  identity that leaves nothing after trimming is refused rather than mapped
  to the bare prefix.
- **Long names are cut before the hash.** A name over the limit (63
  characters, a PostgreSQL identifier's, by default) has its slug cut to fit,
  and the hash still ends it, so two long identities that share a head still
  get different names. The limit must leave room for the prefix, one
  character and the hash, the default included: a prefix too long for it is
  a usage error.

Exit 0 with the name on standard output; exit 2 for a usage error or an
identity with no name.

## The reaper's decision

```bash
bun find-stale-namespaces.ts --owner <id> --inventory <file|-> --live <file|-> \
  --production <name> [--prefix wt_] [--max-length 63] [--now <ISO 8601>] [--json]
```

- `--inventory` — a JSON array of the namespaces that exist, each
  `{ "name", "owner", "expires_at" }`; the last two may be absent. The adapter
  reads them from wherever creation wrote them (a schema comment, a registry
  table, a label). A name may appear twice only with the same owner and
  expiry.
- `--live` — the output of `git worktree list --porcelain`, unchanged. Each
  worktree's branch is mapped to a name by the naming rule above. A worktree
  on no branch (detached, as during a rebase) stops the run: its namespace
  cannot be named, so no orphan could be told apart from it. A bare main
  repository has no working tree and is skipped.
- `--owner` — whose reaper this is. Only that owner's namespaces are
  candidates.
- `--production` — the production namespace's name (required), refused
  outright.
- `--now` — the time to measure expiry against (default: now); tests pass a
  fixed value.

Each namespace is sorted into one bucket:

| Bucket | When | Listed as |
| --- | --- | --- |
| production | its name is `--production` | refused, never a candidate, however it is labelled |
| outside | its name does not start with the prefix | counted, left alone |
| foreign | its owner is someone else | counted, left alone: that owner's reaper decides |
| unlabelled | its owner or expiry is missing | a finding, not reaped: the missing key is the problem |
| expired | its expiry is at or before now | to reap |
| orphaned | no live worktree derives its name | to reap |
| live | none of the above | fine |

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Nothing to reap and nothing unlabelled | `OK — nothing to reap for <owner>; <counts>` |
| 1 | At least one namespace to reap, or one unlabelled | `STALE — …`, then one line per namespace with its reason |
| 2 | Usage or input error | a message on standard error |

The script fails closed: an inventory that is not JSON or not an array, an
entry without a name, an owner that is blank, an expiry that is not a
timestamp with a time zone or names no real date, two entries of one name
that disagree, a live listing that is empty (a failed `git worktree list`
leaves one; a real listing always holds the main checkout), holds a record
that is not a complete porcelain record (an unexpected line, a field given
twice, no `HEAD` object id, not exactly one of `branch` and `detached`),
holds a detached worktree or two branches that derive one name, a missing
`--production`, an empty prefix, a limit too short for the prefix and a bad
option all exit 2.

## From decision to drop

The decision is a report; the drop is a separate, opted-in step, and the
report runs first every time. Every file it writes lives in a directory of
its own run, so two reapers working at once never read each other's census
or plan:

```bash
set -euo pipefail
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git worktree list --porcelain > "$work/live.txt"
status=0
bun find-stale-namespaces.ts --owner "$USER" --inventory inventory.json \
  --live "$work/live.txt" --production public --json > "$work/plan.json" || status=$?
[ "$status" -le 1 ] || exit "$status"
jq -r '.reap[].name' "$work/plan.json" > "$work/reap.txt"   # read it
```

The plan is a snapshot, and the names are deterministic: between the report
and the drop, a worktree can come back on the same branch and recreate the
namespace the plan called orphaned. So the drop decides each name again,
under one lock per name that the create takes too, from a census and labels
read inside that lock, and drops only what is still to reap. Any step that
fails stops the whole drop, never just the one name: a lock not taken
within its bound, a census or label that cannot be read, a re-decision that
exits 2, a `jq` that errors rather than answering no, a drop that fails.

```bash
while read -r NS; do
  (
    flock -w 300 9 || { echo "namespace $NS: lock not taken in 300s" >&2; exit 2; }
    git worktree list --porcelain > "$work/live.now"
    <read the current inventory entry of "$NS"> > "$work/entry.json"
    status=0
    bun find-stale-namespaces.ts --owner "$USER" --inventory "$work/entry.json" \
      --live "$work/live.now" --production public --json > "$work/again.json" || status=$?
    [ "$status" -le 1 ] || exit "$status"
    found=0
    jq -e --arg ns "$NS" 'any(.reap[]; .name == $ns)' "$work/again.json" > /dev/null || found=$?
    case "$found" in
      0) <drop one namespace> "$NS" ;;    # bounded by its own deadline, like the lock
      1) ;;                                # no longer to reap: leave it
      *) exit 2 ;;                         # jq failed, which is not an answer
    esac
  ) 9> "$(git rev-parse --git-common-dir)/namespace-$NS.lock"
done < "$work/reap.txt"
```

The subshell's status is the loop's, so with `set -e` the first failed name
ends the run with that status. The lock is a file lock in the clone, and
that is enough because the census is the clone's own: `orphaned` means no
worktree *of this clone* derives the name, which proves nothing about a
namespace another clone or machine created for the same owner. Where
several clones create namespaces, give each clone its own prefix
(`--prefix`), none of them the start of another, in the create and the
reaper alike: another clone's namespaces then read as outside the prefix and
are left alone, and each reaper judges only names its census can see.

Exit 1 means there is something to reap, so the pipeline goes on to read the
plan; exit 2 is an input or usage error with no plan, and stops it. A
scheduled reaper applies only when a variable or a dispatch input opts in,
never because it merged ([M10's environment hygiene](../../../M10-environments-deploy/README.md#environment-hygiene)
states the rule for every created resource).
