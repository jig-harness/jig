/**
 * Every live driver of a pull request on this host, as the drive's database
 * records it: one row per held `pr-drive-<PR>` lock, of every clone whose
 * state is under the host's state root, whose holder `claimAlive` reads
 * alive, and, for a holder outside this host's process namespace (which
 * `claimAlive` cannot probe), whose heartbeat is fresh, so a killed one
 * stops counting. Each carries what its claim's diagnostics say: the tree it works,
 * its log, when it started and the account identity its passes bill.
 *
 * It is how a reader outside the drive (the dispatcher's slot count, its
 * line) sees drivers that no launch record of its own started: one a
 * pickup armed, or one a person or a repair session started by hand.
 *
 * It reads without creating, migrating or importing anything: a host with
 * no drive database has no driver. A database that cannot be opened or
 * read is a failure value, with why. The database is the one under the
 * host's state root; a `$DRIVE_PR_STATE_DIR` naming one clone's directory
 * (as a driver's own environment does) is not that root.
 */
import { join } from "node:path";
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../../shared/outcome.ts";
import { openReadOnly } from "../../../../../shared/records/db.ts";
import { currentMs, parseMs } from "../../../../../shared/time.ts";
import { heartbeatStaleMs, samePidNamespace } from "../claim.ts";
import type { AccountVendor } from "../identity.ts";
import { dbPathFor, MIGRATIONS } from "../state/db.ts";
import type { LockRow } from "../state/lock.ts";
import { stateRoot } from "../state/store.ts";
import { type Claim, claimAlive, claimOf } from "./locks.ts";

/** A live driver of one pull request, as its lock records it. */
export interface HostDriver {
  /** The clone whose state holds the lock. */
  clone: string;
  pr: number;
  pid: number;
  host: string;
  /** The tree it works; `null` when its claim carries no diagnostics. */
  worktree: string | null;
  log: string | null;
  /** When it took the lock. */
  since: string;
  /** The account identity its passes bill, as the driver last resolved it; `null` when unresolved. */
  identity: string | null;
  vendor: AccountVendor | null;
}

/** A pull request's lock name: `pr-drive-` and the number's digits. */
const PR_LOCK = /^pr-drive-([0-9]+)$/;

/** The live pull-request drivers in the database under `root` (the host's state root by default). */
export function liveHostDrivers(
  root?: string,
): Outcome<HostDriver[], "unreadable"> {
  const what = "the drive's database could not be read for its live drivers";
  const path = attempt("unreadable", what, () =>
    dbPathFor(join(root ?? stateRoot(), "clone")),
  );
  if (!path.ok) return path;
  const opened = openReadOnly({ path: path.value, migrations: MIGRATIONS });
  if (!opened.ok)
    return failed(
      "unreadable",
      `${what}: ${opened.failure.reason}`,
      opened.failure.cause,
    );
  if (opened.value === null) return ok([]);
  const { db } = opened.value;
  try {
    return attempt("unreadable", what, () =>
      (
        db
          .query("SELECT * FROM locks WHERE name GLOB 'pr-drive-[0-9]*'")
          .all() as (LockRow & { clone: string })[]
      ).flatMap((row) => driverOf(row)),
    );
  } finally {
    db.close();
  }
}

function driverOf(row: LockRow & { clone: string }): HostDriver[] {
  const pr = PR_LOCK.exec(row.name)?.[1];
  if (pr === undefined) return [];
  const claim = claimOf(row);
  if (!claimAlive(claim) || !(samePidNamespace(claim) || fresh(claim)))
    return [];
  const diag = claim.diag;
  return [
    {
      clone: row.clone,
      pr: Number(pr),
      pid: claim.pid,
      host: claim.host,
      worktree: diag?.worktree ?? null,
      log: diag?.log ?? null,
      since: diag?.started ?? row.acquired_at,
      identity: diag?.account.account ?? null,
      vendor: diag?.account.vendor ?? null,
    },
  ];
}

/** Whether the holder renewed its heartbeat within the window a live driver keeps. */
function fresh(claim: Claim): boolean {
  const age = currentMs() - parseMs(claim.renewedAt);
  return Number.isFinite(age) && age <= heartbeatStaleMs();
}
