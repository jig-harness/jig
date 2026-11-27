/**
 * How many runs the test lock admits at once on this host now, decided the
 * way the lock decides each run (`shared/resource-lock.ts`): with a static
 * slot count (`LOCK_STATIC_SLOTS=1`), every slot its ceiling allows;
 * otherwise each run the host's load and memory leave room for
 * (`shared/host-load.ts`), never more than `LOCK_SLOTS`. The first run
 * always fits, so the count is never under one.
 */
import { type HostLoad, roomForOneMore } from "../../shared/host-load.ts";
import { attempt, type Outcome } from "../../shared/outcome.ts";
import { slotSettings } from "../../shared/resource-lock.ts";

/**
 * The slots the lock admits at the host's load other than its own runs.
 * The load reading already holds the runs settled on the lock at their real
 * cost, so no configured cost is taken out for them (`_settled`, their count,
 * is kept for callers).
 * Each run then counts from none, at its full cost, as the lock counts a run
 * too fresh for the average to show. Memory is read as it stands; below the
 * floor the lock admits one run at a time. `env` is the environment the lock
 * runs in, whose `LOCK_*` settings decide; a setting the lock refuses leaves
 * the count unread.
 */
export function lockSlots(
  host: HostLoad,
  _settled: number,
  env: Record<string, string | undefined>,
): Outcome<number, "lock-slots-unread"> {
  const settings = attempt(
    "lock-slots-unread",
    "the lock's slot settings not read",
    () => slotSettings(env),
  );
  if (!settings.ok) return settings;
  const { slots, adaptive, policy } = settings.value;
  if (!adaptive) return { ok: true, value: slots };
  // The measured load already holds every settled holder at its real cost,
  // which is never assumed from the configured one; counting each run from
  // none on top of it errs toward fewer slots, never toward a queue the lock
  // would refuse.
  let count = 0;
  while (
    count < slots &&
    roomForOneMore(host, { count, fresh: count }, policy).admit
  )
    count++;
  return { ok: true, value: Math.max(1, count) };
}
