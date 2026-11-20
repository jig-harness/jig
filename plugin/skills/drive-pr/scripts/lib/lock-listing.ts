/** Read the clone's driver-lock claims for the listing and the doctor. */
import { currentMs, parseMs } from "../../../../shared/time.ts";
import { type ClaimDiag, ownParentDriver } from "./claim.ts";
import type { DoctorRow } from "./doctor.ts";
import {
  claimAlive,
  holderGone,
  inspectLock,
  lockLabel,
} from "./driver/locks.ts";

export interface LockRow {
  /** Human name: `PR #123` or `worktree ab12…`. */
  lock: string;
  kind: "pr" | "worktree";
  /** The PR number, or the worktree hash. */
  key: string;
  /** The clone's state directory, beside the database the lock is in. */
  stateDir: string;
  /** The lock's name in the drive's database. */
  name: string;
  /** Where the lock is, for a person: its name and the database. */
  dir: string;
  /**
   * `live`/`stale` are the two verdicts a readable single claim gets, by
   * `claimLive`. The rest are the fail-closed shapes: a lock this listing could
   * not positively interpret is REPORTED, never silently dropped — a dropped
   * row reads as "not held", which is the one thing an unreadable lock never
   * established.
   */
  state: "live" | "stale" | "empty" | "contested" | "unreadable";
  pid: number | null;
  host: string | null;
  hostId?: string | undefined;
  platform: string | null;
  nonce: string | null;
  refreshAgeSec: number | null;
  diag: ClaimDiag | null;
  /** The holder's process is confirmed gone by its recorded identity (`holderGone`); absent with no claim. */
  holderGone?: boolean;
  /**
   * This claim's owner is the reader's OWN parent driver — see
   * `ownParentDriver`. Carried on the row rather than derived at each print
   * site so every surface answers the question identically: the text listing's
   * `self:` line, `--json`, and the `--here` banner. It was derived inline at
   * the text site alone, and a pass that censused with `--json` — the natural
   * machine-readable choice — got no self signal at all, stood down against its
   * own parent and burned two no-op rounds (measured; the same shape was
   * already fixed for the label).
   */
  self: boolean;
  /**
   * `lib/doctor.ts`'s classification of this drive — `null` until
   * `attachDoctorVerdicts` populates it, and permanently `null` for a
   * `worktree`-kind row: doctoring is a per-PR question (progress, quota
   * parks and human-parked items are all recorded per PR, never per
   * worktree-lock), so a worktree row has nothing for the classifier to
   * decide. `readLock` never sets this field — only `attachDoctorVerdicts`
   * does, kept as a separate pass so the read-only lock enumeration
   * `listRows` provides to `stop`/`here` never pays for a `ps` call and a
   * per-worktree `git` probe it does not need.
   */
  doctor: DoctorRow | null;
}

export function rowName(kind: "pr" | "worktree", key: string): string {
  return kind === "pr" ? `PR #${key}` : `worktree ${key.slice(0, 8)}…`;
}

/** The lock name of a row's kind and key. */
export function lockName(kind: "pr" | "worktree", key: string): string {
  return kind === "pr" ? `pr-drive-${key}` : `pr-drive-worktree-${key}`;
}

/** Interpret one driver lock of the clone. A lock nobody holds is `empty`. */
export function readLock(
  stateDir: string,
  kind: "pr" | "worktree",
  key: string,
  name = lockName(kind, key),
): LockRow {
  const row: LockRow = {
    lock: rowName(kind, key),
    kind,
    key,
    stateDir,
    name,
    dir: lockLabel({ stateDir, name }),
    state: "empty",
    pid: null,
    host: null,
    platform: null,
    nonce: null,
    refreshAgeSec: null,
    diag: null,
    self: false,
    doctor: null,
  };
  const claim = inspectLock(stateDir, name);
  if (claim === null) return row;
  const ageMs = currentMs() - parseMs(claim.renewedAt);
  row.pid = claim.pid;
  row.host = claim.host;
  row.hostId = claim.hostId === "" ? undefined : claim.hostId;
  row.platform = claim.platform;
  row.nonce = claim.nonce;
  row.diag = claim.diag;
  row.self = ownParentDriver(claim);
  row.refreshAgeSec = Number.isFinite(ageMs)
    ? Math.max(0, Math.round(ageMs / 1000))
    : null;
  row.state = claimAlive(claim) ? "live" : "stale";
  row.holderGone = holderGone(claim);
  return row;
}
