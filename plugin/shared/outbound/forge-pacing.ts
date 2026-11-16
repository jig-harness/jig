/** Space governed sends across processes without reserving a queue of future slots. */
import { systemClock, type Clock } from "../clock.ts";
import { attempt, type Outcome } from "../outcome.ts";
import { inTransaction, openTransientDatabase } from "../records/db.ts";
import { defaultLedgerPath } from "./ledger.ts";
import { BUDGET_MIGRATIONS } from "./schema.ts";
import { outboundFailure, type OutboundFailure } from "./failure.ts";

/** A shared owner starts at most five governed CLI calls per second. */
export const FORGE_SPACING_MS = 200;

/** Atomically claim a slot now, or return the wait; a crash leaves at most one spacing interval. */
export function claimForgeSlot(
  owner: string,
  now: number,
  path = defaultLedgerPath(),
): Outcome<number> {
  // Pacing must never lower the budget store's contention timeout. Its claim
  // retries asynchronously, whereas budget admission has its own policy.
  const opened = openTransientDatabase({
    path,
    migrations: BUDGET_MIGRATIONS,
    busyMs: 0,
  });
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return attempt(
      "unreachable",
      "Cannot coordinate GitHub request starts",
      () =>
        inTransaction(db, () => {
          const row = db
            .query("SELECT next_at FROM forge_pacing WHERE owner = ?")
            .get(owner) as { next_at: number } | null;
          // Bound a stale record after a backwards clock adjustment as well.
          const wait = Math.min(
            FORGE_SPACING_MS,
            Math.max(0, (row?.next_at ?? now) - now),
          );
          if (wait > 0 && (row?.next_at ?? now) <= now + FORGE_SPACING_MS)
            return wait;
          db.run("DELETE FROM forge_pacing WHERE next_at <= ?", [now]);
          db.run(
            "INSERT INTO forge_pacing(owner, next_at) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET next_at = excluded.next_at",
            [owner, now + FORGE_SPACING_MS],
          );
          return 0;
        }),
    );
  } finally {
    db.close();
  }
}

interface PacingDeps extends Clock {
  claim(owner: string, now: number): Outcome<number>;
}

/** Wait before budget admission, respecting the whole call's deadline and cancellation. */
export async function paceForge(
  owner: string,
  deadlineAt: number,
  signal?: AbortSignal,
  deps: PacingDeps = { ...systemClock, claim: claimForgeSlot },
): Promise<OutboundFailure | null> {
  for (;;) {
    const remaining = deadlineAt - deps.now();
    if (remaining <= 0)
      return outboundFailure(
        "too-costly",
        "GitHub call deadline expired before sending; nothing was sent",
      );
    if (signal?.aborted)
      return outboundFailure(
        "unreachable",
        "GitHub call cancelled before sending; nothing was sent",
      );
    const claimed = deps.claim(owner, deps.now());
    if (!claimed.ok) {
      const cause = claimed.failure.cause as { code?: unknown } | undefined;
      if (cause?.code === "SQLITE_BUSY") {
        await deps.sleep(Math.min(25, remaining), signal);
        continue;
      }
      // Unavailable pacing storage governs nothing, as the budget's does: the
      // send goes ahead rather than stopping every otherwise-working read.
      return null;
    }
    if (signal?.aborted || deps.now() >= deadlineAt) continue;
    if (claimed.value === 0) return null;
    await deps.sleep(Math.min(claimed.value, remaining), signal);
  }
}
