# Resource lock

Bound a heavy command across [worktrees](../../../../GLOSSARY.md) so several
agents on one machine don't run more full build-and-test passes at once than
the machine can carry. `with-resource-lock.ts` runs your command under a named,
machine-wide lock: as many holders run as the machine has room for, the rest
wait their turn.

Without it, ten agents each launching `test` at once multiply the load; every
run slows down, caches fight, and flaky timeouts appear that no single change
explains. A lock that lets one run at a time fixes that, but on a large machine
it leaves most of the cores idle while every other run queues behind one. With
[load admission](../../../../GLOSSARY.md), a run starts while the machine has room
for one more and waits otherwise.

## Why ownership is recorded atomically

The lock is a **symlink whose target is the holder's process id**. Creating a
symlink is **atomic** on [POSIX](../../../../GLOSSARY.md) and fails if the name
already exists: if two processes race, exactly one atomic symlink creation
succeeds. Crucially, because the target *is* the pid, the lock and its owner-identity are recorded in
the **same atomic step** — there is no "won the lock but hasn't written its owner
yet" window. (A `mkdir` directory plus a separate pid file *does* have that
window: a holder paused between the two leaves an ownerless lock another process
could steal, breaking mutual exclusion.) If a holder crashes, the next contender
reads the symlink target, sees that pid is gone from the process table, and
reclaims the lock instead of waiting forever.

On Windows, the wrapper writes the process id into a unique temporary file,
then creates a **[hard link](../../../../GLOSSARY.md)** (a second filesystem
name for that same file) at the lock path. Creating that name is atomic and
fails if another holder owns it. The process id is already present when
ownership becomes visible, so there is no create-then-write gap and no
symbolic-link permission requirement. The lock root must support hard links,
as a native local Windows filesystem does.

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
| `LOCK_POLL` | env | `0.2` | poll interval while waiting, in seconds (0.001 to 3600; anything else is rejected). With several slots it is the shortest pause between sweeps, which otherwise last 2 to 5 seconds. The last sleep is shortened so the wait never exceeds `LOCK_TIMEOUT` |
| `LOCK_ROOT` | env | `${TMPDIR:-/tmp}` | where the lock lives; a machine-global path is what makes it cross-worktree |
| `LOCK_SLOTS` | env | `64`, or `8` with `LOCK_STATIC_SLOTS=1` | the most runs that may hold the lock at once (1 to 64). `1` makes it a plain mutex, as it was before slots |
| `LOCK_STATIC_SLOTS` | env | `0` | `1` admits up to `LOCK_SLOTS` runs whatever the load |
| `LOCK_TARGET_UTIL` | env | `0.85` | the share of the cores the predicted load must stay under (above 0, at most 4) |
| `LOCK_RUN_COST` | env | `4` | the load one run adds; set it to the command's parallelism (above 0) |
| `LOCK_MIN_MEM_GB` | env | `8` | the available memory, in gigabytes (1024³ bytes), that must remain for one more run to start |
| exclusive | `--exclusive` | off | wait for every slot, hold them all, and hold back new runs meanwhile |

Behaviour: acquire a slot of the lock (waiting up to `LOCK_TIMEOUT`), run the
command, release the slot on exit; a run that waits says what it waits on and
who holds the slots, again when that changes, and how long it waited once it
starts; interrupt and termination signals are forwarded to
the child, and a crashed holder is reclaimed on the next acquisition. Exit
codes: the **command's own** exit code on success; `2` on a usage error; `3` if
the lock couldn't be acquired in time.

## Slots and load admission

Slot 0 is the lock's own name, `jig-lock.<name>`: an earlier version of this
script knows only that name, so it still excludes and queues with this one.
Slots 1 and up are `jig-lock.<name>-slot-<n>`, each the same atomic
process-id lock. A waiter takes a free slot 0 at once. For any other slot it
first asks whether the machine has room for one more run:

- the **predicted load**, the one-minute load average plus `LOCK_RUN_COST`
  for each run that took its slot in the last minute (the average has not
  caught up with those yet), plus one more run's cost, must stay under the
  cores times `LOCK_TARGET_UTIL`;
- the **available memory** must stay above `LOCK_MIN_MEM_GB`;
- the **first run** is always admitted, so the queue always moves.

The check and the sweep that follows it run under a short admission lock
(`jig-lock.<name>.admission`), so each new holder is counted before the next
waiter decides. A waiter sweeps the slots without blocking and takes the first
free one, with a jittered pause of 2 to 5 seconds between sweeps so waiters do
not move in step. A slot whose holder's process id answers is skipped without
the identity check; every tenth sweep judges each holder fully and reclaims a
dead one's slot.

Only an explicit denial keeps a waiter waiting. A reading of the host that
fails admits, and `LOCK_SLOTS` then bounds the runs, so a broken reading never
wedges the queue. Waiting sweeps rather than queues, so waiters are not
admitted in arrival order. Several waiters can see the same headroom within one
sweep and overshoot by a run; counting the runs of the last minute at their
full cost bounds that to the next sweep. The host reading and the admission
rule are `plugin/shared/host-load.ts`, which every Jig mechanism that asks
whether the host can take one more run reads.

**Exclusive holders.** A holder that needs the machine to itself runs with
`--exclusive`. It announces itself (`jig-lock.<name>.exclusive`), which stops
new runs from taking any slot, then takes every slot the lock can have, 0 to
63, in that order, waiting for each run that holds one to finish. It holds them
all while its command runs. Exclusive holders queue on the announcement, so two
never deadlock on the slots. One that cannot take every slot within
`LOCK_TIMEOUT` releases what it took and exits `3`.

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
- **Foreign leftover** — a directory, or a file that does not carry a live
  Windows owner, left at the lock path by a different or older tool would
  otherwise wedge the lock; it is cleared before
  acquisition (and the acquire step verifies it really holds the symlink, so a
  stray `ln` into a leftover directory can't be mistaken for a win). A foreign
  entry has no recorded owner to compare, so a tool that is still alive and
  removing its own leftover at the same moment is outside what this guards.

Process-id reuse is told apart by the holder's
[process identity](../../../../GLOSSARY.md) (its host, its boot, its process id
and its start time), which a holder writes beside the lock, in
`<lock>.holder`, once it holds it, and removes before it releases. The lock
itself still names only the process id, so a wrapper from an earlier version
excludes this one as before. When the lock's process id answers, a contender
reads the start time of the process that has it now, and a lock whose process
id belongs to a process started at another time is reclaimed like a dead
holder's. The recorded identity counts only when it names the lock's process
id and was written no earlier than the lock, so a leftover never judges a
later holder. A reclaim, and a wait that runs out, say whose lock it was and
why.

The residual caveat is reuse without that record: a lock an earlier version
took, a holder that could not write its identity, or any lock on Windows,
where the check reads no creation time. If the OS has recycled the dead
holder's id for an unrelated live process there, the lock looks held until
`LOCK_TIMEOUT` elapses (then exit `3`), the safe direction to fail. It never
tears down a lock a live holder still owns.

## Files

| File | Role |
|------|------|
| `with-resource-lock.ts` | the lock wrapper; lock via `LOCK_NAME`/`--lock`, waits, slots, admission and bypass via env, `--exclusive` |
| `with-resource-lock.test.ts` | paired self-test of a single slot (mutual exclusion, bypass, stale reclaim, a reused process id, exit codes) |
| `with-resource-lock-slots.test.ts` | paired self-test of slots (the ceiling, load and memory admission, a failing reading, an earlier version's lock, exclusive holders) |

Run the self-tests with `bun test ./with-resource-lock.test.ts ./with-resource-lock-slots.test.ts`. It scrubs `CI`
from its own environment first, so the locking assertions still lock when the test itself
runs in CI.
