# Port allocator

Give every [worktree](../../../../GLOSSARY.md) its own port without a registry
or a lock. `allocate-port.sh` maps a worktree identifier (its branch or
directory name) to a stable port by hashing it into a configurable range, so the
**same** worktree always gets the **same** port and two **different** worktrees
almost never clash.

Without this, every agent's dev server or test listener defaults to the same
hardcoded port; the second one to start crashes with "address already in use",
and the agent — not knowing another worktree exists — misreads it as a bug in
the app.

## What it does

Reads a worktree id from arg `$1` or `WORKTREE_ID`, hashes it with a portable
checksum (`cksum`, in coreutils — identical output on macOS and Linux), reduces
that modulo `PORT_SPAN`, and offsets by `PORT_BASE`. The result is printed on
stdout and is always inside `[PORT_BASE, PORT_BASE + PORT_SPAN)`.

```sh
allocate-port.sh "$(git branch --show-current)"     # -> a stable port
PORT_BASE=30000 PORT_SPAN=500 allocate-port.sh main
```

| Setting | Via | Default | Meaning |
|---------|-----|---------|---------|
| worktree id | arg `$1` or `WORKTREE_ID` | — (required) | the thing hashed; a branch or dir name |
| `PORT_BASE` | env | `20000` | first port in the range |
| `PORT_SPAN` | env | `1000` | how many ports the range holds |

Exit codes: `0` prints the port; `2` on a missing id or a bad range (a
non-integer or an out-of-bounds `PORT_BASE`/`PORT_SPAN`).

## The collision caveat

Hashing trades a registry for a small collision chance: two different ids can
land on the same port. The odds follow a birthday-problem curve — with a
1000-port span they stay low for a handful of worktrees but climb as the count
grows, and a single unlucky pair can coincide even sooner. Mitigations, cheapest
first:

- **Size the range above your concurrency.** Keep `PORT_SPAN` comfortably larger
  than the number of worktrees you ever run at once; the wider the range, the
  rarer the clash.
- **Give related services separate ranges.** An app and its database each get
  their own `PORT_BASE` (e.g. `20000` and `21000`) so a within-service clash is
  the only kind possible.
- **Probe-for-free fallback (future, not shipped).** A later revision could,
  on a detected clash, walk forward from the hashed port to the next free one
  and cache the result per worktree — deterministic first guess, guaranteed-free
  final answer. Left out here to keep the script dependency-free and stateless;
  noted so the design is on record.

## Files

| File | Role |
|------|------|
| `allocate-port.sh` | the allocator; id via arg/`WORKTREE_ID`, range via env |
| `test-allocate-port.sh` | paired self-test (determinism, range, distinctness, exit 2) |
| `fixtures/golden-ports.tsv` | checked-in id → port pairs the self-test asserts against |

Run the self-test with `./test-allocate-port.sh`.
