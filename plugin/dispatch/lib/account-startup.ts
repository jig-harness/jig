/** Host-wide startup episodes, shared by the tick and the pass wrappers. */
import { isMapping } from "../../shared/config-layers.ts";
import { stateRoot } from "../receipts.ts";
import type { LineNeed } from "./dashboard-contract.ts";
import type { MachineConfig } from "./machine-config.ts";
import { existingStateDb, inTransaction, stateDb } from "./state.ts";

type Account = { vendor: string; configDir: string };
type Problem = "sign-in" | "breaker";

/** Keep the first sighting throughout an episode and prefer a known sign-in failure. */
export function recordAccountStartupProblem(
  account: Account,
  kind: Problem,
  at: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `INSERT INTO account_startup (vendor, config_dir, problem, since, seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (vendor, config_dir) DO UPDATE SET
       problem = CASE WHEN problem = 'sign-in' THEN problem ELSE excluded.problem END,
       since = COALESCE(since, excluded.since),
       seen_at = excluded.seen_at
     WHERE seen_at IS NULL OR seen_at <= excluded.seen_at`,
    )
    .run(account.vendor, account.configDir, kind, at, at);
}

/** A verified sign-in lifts the sign-in episode. A probe cannot settle an unknown startup failure. */
export function recordAccountSignInSuccess(
  account: Account,
  at: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `UPDATE account_startup SET problem = NULL, since = NULL, seen_at = ?
     WHERE vendor = ? AND config_dir = ? AND problem = 'sign-in' AND seen_at <= ?`,
    )
    .run(at, account.vendor, account.configDir, at);
}

const DEATH_KINDS = ["died", "unstarted", "quota", "sign-in"] as const;
type DeathKind = (typeof DEATH_KINDS)[number];
type Death = { at: string; kind: DeathKind };

function isDeath(value: unknown): value is Death {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    DEATH_KINDS.some((kind) => kind === value.kind)
  );
}

/** A pass that actually ran discards deaths from older launches and clears any older incident. */
export function recordWorkingStartup(
  account: Account,
  startedAt: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `INSERT INTO account_startup (vendor, config_dir, working_at)
       VALUES (?, ?, ?)
       ON CONFLICT (vendor, config_dir) DO UPDATE SET
         working_at = excluded.working_at,
         death_history = (
           SELECT json_group_array(json(value)) FROM json_each(death_history)
           WHERE json_extract(value, '$.at') > excluded.working_at
         ),
         problem = CASE WHEN seen_at <= excluded.working_at THEN NULL ELSE problem END,
         since = CASE WHEN seen_at <= excluded.working_at THEN NULL ELSE since END
       WHERE working_at IS NULL OR working_at < excluded.working_at`,
    )
    .run(account.vendor, account.configDir, startedAt);
}

/** Keep a bounded suffix in launch order, independent of which wrapper publishes first. */
export function recordStartupDeath(
  account: Account,
  kind: DeathKind,
  startedAt: string,
  threshold: number,
  root = stateRoot(),
): number {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const prior = db
      .query(
        `SELECT working_at, death_history FROM account_startup
         WHERE vendor = ? AND config_dir = ?`,
      )
      .get(account.vendor, account.configDir) as {
      working_at: string | null;
      death_history: string;
    } | null;
    if (prior?.working_at != null && prior.working_at >= startedAt) return 0;
    const parsed: unknown = JSON.parse(prior?.death_history ?? "[]");
    const history = Array.isArray(parsed) ? parsed.filter(isDeath) : [];
    const keep = Math.max(threshold, history.length);
    history.push({ at: startedAt, kind });
    history.sort((a, b) => a.at.localeCompare(b.at));
    const recent = history.slice(-keep);
    db.query(
      `INSERT INTO account_startup (vendor, config_dir, death_history)
       VALUES (?, ?, ?)
       ON CONFLICT (vendor, config_dir) DO UPDATE SET death_history = excluded.death_history`,
    ).run(account.vendor, account.configDir, JSON.stringify(recent));
    let count = 0;
    for (const death of recent.reverse()) {
      if (death.kind !== kind) break;
      count += 1;
    }
    return count;
  });
}

/** A host-wide incident is presented once, independent of how many repositories it affected. */
export function accountStartupNeeds(
  accounts: MachineConfig["accounts"],
  root = stateRoot(),
): LineNeed[] {
  const db = existingStateDb(root);
  if (db === null) return [];
  const read = db.query(
    `SELECT problem, since FROM account_startup
     WHERE vendor = ? AND config_dir = ? AND problem IS NOT NULL`,
  );
  return accounts.flatMap((account): LineNeed[] => {
    const row = read.get(account.vendor, account.configDir) as {
      problem: Problem;
      since: string;
    } | null;
    if (row === null) return [];
    const signIn = row.problem === "sign-in";
    return [
      {
        cause: signIn ? "account-sign-in" : "account-startup",
        act: signIn ? "Do" : "Investigate",
        stage: "steer",
        repo: "host",
        target: `account ${account.name}`,
        pr: null,
        item: null,
        url: null,
        title: null,
        since: row.since,
        reason: signIn
          ? `Sign in again for ${account.name} in its configuration directory ${account.configDir}.`
          : `Investigate repeated startup failures for ${account.name} in its configuration directory ${account.configDir}.`,
        decisions: [],
        notified: null,
        workspaces: [],
      },
    ];
  });
}
