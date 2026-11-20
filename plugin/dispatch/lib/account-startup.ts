/** Host-wide startup episodes, shared by the tick and the pass wrappers. */
import { stateRoot } from "../receipts.ts";
import type { LineNeed } from "./dashboard-contract.ts";
import type { MachineConfig } from "./machine-config.ts";
import { existingStateDb, stateDb } from "./state.ts";

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

/** A pass that actually ran clears a consecutive count and any older incident. */
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
         death_class = CASE WHEN death_at <= excluded.working_at THEN NULL ELSE death_class END,
         deaths = CASE WHEN death_at <= excluded.working_at THEN 0 ELSE deaths END,
         problem = CASE WHEN seen_at <= excluded.working_at THEN NULL ELSE problem END,
         since = CASE WHEN seen_at <= excluded.working_at THEN NULL ELSE since END
       WHERE working_at IS NULL OR working_at < excluded.working_at`,
    )
    .run(account.vendor, account.configDir, startedAt);
}

/** A different kind of startup failure breaks a run of equal deaths. */
export function recordStartupDeath(
  account: Account,
  kind: "died" | "unstarted" | "quota" | "sign-in",
  startedAt: string,
  root = stateRoot(),
): number {
  const read = stateDb(root)
    .query(
      `INSERT INTO account_startup (vendor, config_dir, death_class, deaths, death_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (vendor, config_dir) DO UPDATE SET
         deaths = CASE WHEN death_class = excluded.death_class THEN deaths + 1 ELSE 1 END,
         death_class = excluded.death_class,
         death_at = max(COALESCE(death_at, excluded.death_at), excluded.death_at)
       WHERE working_at IS NULL OR working_at < excluded.death_at
       RETURNING deaths`,
    )
    .get(account.vendor, account.configDir, kind, startedAt) as {
    deaths: number;
  } | null;
  return read?.deaths ?? 0;
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
