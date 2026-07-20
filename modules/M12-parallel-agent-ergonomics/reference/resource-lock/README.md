# Resource lock

Serialize a heavy command across [worktrees](../../../../GLOSSARY.md) so several
agents on one machine don't run full build-and-test passes at the same time and
thrash the machine. `with-resource-lock.sh` runs your command under a named,
machine-wide lock: one holder runs, the rest wait their turn.

Without it, three agents each launching `test` at once triple the load; every
run slows down, caches fight, and flaky timeouts appear that no single change
explains. With it, the runs queue and each gets a clean machine.

## Why a symlink lock

The lock is a **symlink whose target is the holder's process id**. Creating a
symlink is **atomic** on [POSIX](../../../../GLOSSARY.md) and fails if the name
already exists: if two processes race, exactly one `ln -s` succeeds. Crucially,
because the target *is* the pid, the lock and its owner-identity are recorded in
the **same atomic step** — there is no "won the lock but hasn't written its owner
yet" window. (A `mkdir` directory plus a separate pid file *does* have that
window: a holder paused between the two leaves an ownerless lock another process
could steal, breaking mutual exclusion.) If a holder crashes, the next contender
reads the symlink target, sees that pid is gone from the process table, and
reclaims the lock instead of waiting forever.

## What it does

```sh
with-resource-lock.sh pnpm test                 # lock "heavy" (default)
LOCK_NAME=build with-resource-lock.sh make build
with-resource-lock.sh --lock e2e -- ./run-e2e.sh
```

| Setting | Via | Default | Meaning |
|---------|-----|---------|---------|
| lock name | `LOCK_NAME` or `--lock NAME` | `heavy` | which lock to contend on; distinct names run concurrently |
| `LOCK_TIMEOUT` | env | `60` | seconds to wait for the lock before giving up |
| `LOCK_POLL` | env | `0.2` | poll interval while waiting, in seconds (must be a positive number; `0`/non-numeric is rejected) |
| `LOCK_ROOT` | env | `${TMPDIR:-/tmp}` | where the lock lives; a machine-global path is what makes it cross-worktree |

Behaviour: acquire the lock (waiting up to `LOCK_TIMEOUT`), run the command,
release the lock on exit (an `EXIT`/`INT`/`TERM` trap, so a crash still frees
it). Exit codes: the **command's own** exit code on success; `2` on a usage
error; `3` if the lock couldn't be acquired in time.

## CI bypass

On a [CI](../../../../GLOSSARY.md) runner each job already runs on its own
isolated machine, so there is nothing to serialize and the wait is pure latency.
When `CI=1` (or `CI=true`) or `RESOURCE_LOCK_BYPASS=1`, the wrapper skips locking
entirely and runs the command immediately. This is why the same command can sit
behind the mutex locally and run unguarded in CI — see the module
[mappings](../../mappings.md) for the per-provider `CI` signal.

## Reclaim, and its one caveat

Two stale shapes are recovered, each under an atomic guard so two waiters can't
both reclaim-and-run:

- **Dead holder** — the holder died; the next contender reads the symlink
  target, sees that pid is gone from the process table, and reclaims. Because
  owner-identity is atomic with acquisition, an existing symlink *always* names a
  real (once-live) holder — there is no ownerless state to mis-handle.
- **Non-symlink leftover** — a directory or file left at the lock path by a
  different or older tool would otherwise wedge the lock; it is cleared before
  acquisition (and the acquire step verifies it really holds the symlink, so a
  stray `ln` into a leftover directory can't be mistaken for a win).

The one residual caveat is process-id reuse: if the OS has recycled the dead
holder's id for an unrelated live process, the lock looks held until
`LOCK_TIMEOUT` elapses (then exit `3`) — the safe direction to fail. It never
tears down a lock a live holder still owns.

## Files

| File | Role |
|------|------|
| `with-resource-lock.sh` | the mutex wrapper; lock via `LOCK_NAME`/`--lock`, waits + bypass via env |
| `test-with-resource-lock.sh` | paired self-test (mutual exclusion, bypass, stale reclaim, exit codes) |

Run the self-test with `./test-with-resource-lock.sh`. It scrubs `CI` from its
own environment first, so the locking assertions still lock when the test itself
runs in CI.
