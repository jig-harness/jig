# Resource lock

Serialize a heavy command across [worktrees](../../../../GLOSSARY.md) so several
agents on one machine don't run full build-and-test passes at the same time and
thrash the machine. `with-resource-lock.ts` runs your command under a named,
machine-wide lock: one holder runs, the rest wait their turn.

Without it, three agents each launching `test` at once triple the load; every
run slows down, caches fight, and flaky timeouts appear that no single change
explains. With it, the runs queue and each gets a clean machine.

## Why ownership is recorded atomically

The lock is a **symlink whose target is the holder's process id**. Creating a
symlink is **atomic** on [POSIX](../../../../GLOSSARY.md) and fails if the name
already exists: if two processes race, exactly one atomic symlink creation succeeds. Crucially,
because the target *is* the pid, the lock and its owner-identity are recorded in
the **same atomic step** — there is no "won the lock but hasn't written its owner
yet" window. (A `mkdir` directory plus a separate pid file *does* have that
window: a holder paused between the two leaves an ownerless lock another process
could steal, breaking mutual exclusion.) If a holder crashes, the next contender
reads the symlink target, sees that pid is gone from the process table, and
reclaims the lock instead of waiting forever.

On Windows, the wrapper writes the process id into a unique temporary file,
then creates a **[hard link](../../../../GLOSSARY.md)** (a second filesystem name for that same file) at
the lock path. Creating that name is atomic and fails if another holder owns
it. The process id is already present when ownership becomes visible, so
there is no create-then-write gap and no symbolic-link permission requirement.
The lock root must support hard links, as a native local Windows filesystem does. The
POSIX symlink protocol remains compatible with the previous Bash wrapper.

## What it does

```sh
bun with-resource-lock.ts pnpm test                 # lock "heavy" (default)
LOCK_NAME=build bun with-resource-lock.ts make build
bun with-resource-lock.ts --lock e2e -- ./run-e2e.sh
```

| Setting | Via | Default | Meaning |
|---------|-----|---------|---------|
| lock name | `LOCK_NAME` or `--lock NAME` | `heavy` | which lock to contend on; distinct names run concurrently |
| `LOCK_TIMEOUT` | env | `60` | whole seconds to wait for the lock before giving up (0 to 604800) |
| `LOCK_POLL` | env | `0.2` | poll interval while waiting, in seconds (0.001 to 3600; anything else is rejected). The last sleep is shortened so the wait never exceeds `LOCK_TIMEOUT` |
| `LOCK_ROOT` | env | `${TMPDIR:-/tmp}` | where the lock lives; a machine-global path is what makes it cross-worktree |

Behaviour: acquire the lock (waiting up to `LOCK_TIMEOUT`), run the command,
release the lock on exit; interrupt and termination signals are forwarded to
the child, and a crashed holder is reclaimed on the next acquisition. Exit codes: the **command's own** exit code on success; `2` on a usage
error; `3` if the lock couldn't be acquired in time.

## CI bypass

On a [CI](../../../../GLOSSARY.md) runner each job already runs on its own
isolated machine, so there is nothing to serialize and the wait is pure latency.
When `CI=1` (or `CI=true`) or `RESOURCE_LOCK_BYPASS=1`, the wrapper skips locking
entirely and runs the command immediately. This is why the same command can sit
behind the mutex locally and run unguarded in CI — see the module
[mappings](../../mappings.md) for the per-provider `CI` signal.

## Reclaim, and its one caveat

Two stale shapes are recovered. The filesystem has no "delete only if it still
holds this value" operation, so removal is made safe by a **claim**: a lock is
only ever removed because its recorded owner is a dead process id, and a dead id
never records a new lock. Before removing it, a reclaimer publishes a claim file
named after that dead owner (`<lock>.reclaim.<pid>`, recorded atomically the same
way as the lock), re-reads the lock, and removes it only if it still names that
dead owner. A lock that was already replaced by a live holder's is therefore
never removed, and a holder that releases mid-check can't be mistaken for a
stale lock (an empty read means "nothing there", never "stale"). Acquiring the
lock takes no claim. A claim left by a reclaimer that itself crashed is stale in
the same way and is recovered by the same rule, with a claim on that dead
reclaimer, so a crash can never wedge recovery.

- **Dead holder** — the holder died; the next contender reads the recorded
  owner, sees that pid is gone from the process table, and reclaims. Because
  owner-identity is atomic with acquisition, an existing lock *always* names a
  real (once-live) holder — there is no ownerless state to mis-handle.
- **Foreign leftover** — a directory, or a file that does not carry a live Windows owner, left at the lock path by a
  different or older tool would otherwise wedge the lock; it is cleared before
  acquisition (and the acquire step verifies it really holds the symlink, so a
  stray `ln` into a leftover directory can't be mistaken for a win). A foreign
  entry has no recorded owner to compare, so a tool that is still alive and
  removing its own leftover at the same moment is outside what this guards.

The one residual caveat is process-id reuse: if the OS has recycled the dead
holder's id for an unrelated live process, the lock looks held until
`LOCK_TIMEOUT` elapses (then exit `3`) — the safe direction to fail. It never
tears down a lock a live holder still owns.

## Files

| File | Role |
|------|------|
| `with-resource-lock.ts` | the mutex wrapper; lock via `LOCK_NAME`/`--lock`, waits + bypass via env |
| `with-resource-lock.test.ts` | paired self-test (mutual exclusion, bypass, stale reclaim, exit codes) |

Run the self-test with `bun test ./with-resource-lock.test.ts`. It scrubs `CI` from its
own environment first, so the locking assertions still lock when the test itself
runs in CI.
