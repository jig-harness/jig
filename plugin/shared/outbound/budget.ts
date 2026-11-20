/**
 * A tracker credential's request budget, one record per credential that every
 * process on the machine shares: the dispatcher's ticks, the pickup and
 * follow-up passes it starts, and the skills a person runs.
 *
 * A tracker's transport asks the budget before each request (`admit`, which also reserves that request's part of the request count; a query's complexity is known only from its answer) and
 * tells it what each answer said of the limits (`observe`). While the
 * tracker has refused the credential (its rate limit is spent), no request
 * leaves the machine until the reset the answer named: `admit` throws a
 * `TrackerRateLimited` at once, naming the reset, so a caller waits rather
 * than sends a request the tracker would refuse again. A process that runs
 * the dispatcher's reads (`setDispatcherShare`) also stops at its share of
 * each window, leaving the rest of the budget to passes and people.
 *
 * The arithmetic (what a record holds, how an answer merges into it, when a
 * request is admitted) is `budget-governor.ts`, which runs on every
 * platform; this module keeps the machine's records.
 *
 * The record lives in a small SQLite database under the Jig state directory
 * (`~/.local/state/jig/tracker/budget.sqlite`, table `tracker_budget`),
 * keyed by the adapter and a hash of the credential, never the credential
 * itself. A store that cannot be opened or written governs nothing: the
 * request goes out as it would without a budget, since a broken store must
 * not stop every tracker read on the machine.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { errnoCode, swallow } from "../errors.ts";
import { inTransaction, openDatabase } from "../records/db.ts";
import {
  type BudgetGovernor,
  type BudgetRecord,
  type BudgetStore,
  budgetGovernorWith,
} from "./budget-governor.ts";
import { recordFromText } from "./budget-shape.ts";
import { BUDGET_MIGRATIONS } from "./schema.ts";

export {
  type AdmitOptions,
  type BudgetAnswer,
  type BudgetGovernor,
  type BudgetRecord,
  type BudgetStore,
  type BudgetWindow,
  isRateLimited,
  memoryBudgetStore,
  TrackerRateLimited,
  type Unexplained,
} from "./budget-governor.ts";

/** How long a credential stays limited when the refusal named no reset. */
export const FALLBACK_LIMIT_MS = 15 * 60_000;

/** The share of each window the dispatcher's reads may use when the machine file names none. */
export const DEFAULT_DISPATCHER_SHARE = 0.5;

/** The key a credential's record is kept under: the adapter and a hash of the secret, never the secret. */
export function credentialKey(adapter: string, secret: string): string {
  const hash = createHash("sha256").update(secret).digest("hex").slice(0, 16);
  return `${adapter}:${hash}`;
}

/** A record read back from the store; a damaged one reads as none. */
export function parseRecord(text: string): BudgetRecord | null {
  const read = recordFromText(text);
  if (read.ok) return read.value;
  if (read.failure.code === "not-json")
    swallow(read.failure.cause, read.failure.reason);
  return null;
}

/** The machine's budget database: `~/.local/state/jig/tracker/budget.sqlite`. */
export function budgetPath(home = homedir()): string {
  return join(home, ".local", "state", "jig", "tracker", "budget.sqlite");
}

/** The SQLite store at `path`; one that cannot be opened governs nothing. */
export function sqliteBudgetStore(path = budgetPath()): BudgetStore {
  let db: Database | null | undefined;
  const open = (): Database | null => {
    if (db !== undefined) return db;
    const opened = openDatabase({ path, migrations: BUDGET_MIGRATIONS });
    if (!opened.ok) swallow(opened.failure, "the tracker budget store");
    db = opened.ok ? opened.value : null;
    return db;
  };
  const get = (d: Database, key: string): BudgetRecord | null => {
    const row = d
      .query("SELECT value FROM tracker_budget WHERE key = ?")
      .get(key) as { value: string } | null;
    return row === null ? null : parseRecord(row.value);
  };
  return {
    read(key) {
      try {
        const d = open();
        return d === null ? null : get(d, key);
      } catch (error) {
        swallow(error, "read the tracker budget");
        return null;
      }
    },
    update(key, change, nonblocking) {
      try {
        const d = open();
        if (d === null) return;
        inTransaction(
          d,
          () => {
            const next = change(get(d, key));
            if (next === null) return;
            d.query(
              "INSERT OR REPLACE INTO tracker_budget (key, value) VALUES (?, ?)",
            ).run(key, JSON.stringify(next));
          },
          nonblocking ? 0 : undefined,
        );
      } catch (error) {
        if (nonblocking && errnoCode(error) === "SQLITE_BUSY") throw error;
        swallow(error, "write the tracker budget");
      }
    },
  };
}

let dispatcherShare: number | null = null;

/**
 * Make this process's requests the dispatcher's: each window is used only
 * down to `1 - share` of its limit. `null` lifts the cap (a pass or a
 * person's skill uses the whole budget).
 */
export function setDispatcherShare(share: number | null): void {
  dispatcherShare = share;
}

/** The variable that hands this process's share to an outbound-capable child it starts on the dispatcher's behalf. */
const DISPATCHER_SHARE_ENV = "JIG_OUTBOUND_SHARE";

/** The share to hand a child, for `DISPATCHER_SHARE_ENV`; absent when this process's requests use all of the budget. */
export function shareForChild(): Record<string, string> {
  return dispatcherShare === null
    ? {}
    : { [DISPATCHER_SHARE_ENV]: String(dispatcherShare) };
}

/** Take the share a parent handed this process: the child's requests stay inside the dispatcher's, whatever the parent's own process held. Nothing is changed when none was handed or it does not read as a share between 0 and 1. */
export function inheritDispatcherShare(
  env: Record<string, string | undefined> = process.env,
): void {
  const share = Number(env[DISPATCHER_SHARE_ENV] ?? Number.NaN);
  if (Number.isFinite(share) && share >= 0 && share <= 1)
    setDispatcherShare(share);
}

/** The share this process's requests may use; `null` for all of it. */
function currentShare(): number | null {
  return dispatcherShare;
}

/** A governor over `store`; `clock` and `share` are for tests, and `share` is this process's dispatcher share when left out. */
export function budgetGovernor(
  store: BudgetStore,
  opts: { clock?: () => number; share?: () => number | null } = {},
): BudgetGovernor {
  return budgetGovernorWith(store, {
    ...opts,
    share: opts.share ?? currentShare,
  });
}

let machineGovernor: BudgetGovernor | undefined;

/** The machine's governor, over the store in the Jig state directory. */
export function defaultGovernor(): BudgetGovernor {
  machineGovernor ??= budgetGovernor(sqliteBudgetStore());
  return machineGovernor;
}
