/**
 * Whether a dispatcher still takes over a silent drive whose driver this host
 * shows gone, as the tick reads it beside this machine's launch records,
 * other hosts' launch claims and the pull request's recovery budget.
 */
import { driveHold } from "../../dispatch/lib/actions/drive-hold.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import {
  type DriveClaims,
  foreignHold,
  settleSharedTakeovers,
} from "../../dispatch/lib/shared-launches.ts";
import { settleOwnDrives } from "../../dispatch/lib/tick-shared.ts";
import {
  classifyLedger,
  type ParkReading,
  type PrFacts,
} from "../../dispatch/lib/sources/ledgers.ts";
import { stallThresholdMs } from "../../skills/drive-pr/scripts/lib/doctor.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import type { PullDoc } from "./forge.ts";
import { currentMs } from "../../shared/time.ts";

/**
 * Why no dispatcher takes the drive over: a takeover that already ended on
 * these ledger facts, or a spent budget; `null` while one is still available.
 */
export function takeoverSettled(
  pull: PullDoc,
  records: ReadRecord[],
  sharedClaims: SharedClaim[],
  host: string | null,
  ledger: Ledger,
  park: ParkReading,
  base: PrFacts["base"],
): string | null {
  const classified = classifyLedger(
    ledger,
    currentMs(),
    stallThresholdMs(),
    park,
    {
      head: pull.head,
      mergeable: pull.mergeable,
      ...(base === undefined ? {} : { base }),
    },
  );
  if (classified.class !== "silent") return null;
  const silent = {
    number: pull.number,
    url: pull.url,
    title: pull.title,
    head: pull.head,
    ...classified,
    evidence: {
      generation: ledger.generation,
      exit: ledger.driver.exit ?? null,
      heartbeat: ledger.driver.heartbeat,
      started: ledger.driver.started ?? null,
      driverGone: true,
    },
  };
  const claims: DriveClaims = new Map([
    [pull.number, { ok: true as const, value: sharedClaims }],
  ]);
  const own = host ?? "";
  const mine = driveHold(silent, records);
  if (mine.kind === "refused") return mine.why;
  const theirs = foreignHold(silent, claims.get(pull.number), own);
  if (theirs.kind === "refused" || theirs.kind === "unread") {
    const [taken] = settleSharedTakeovers([silent], claims, own);
    return taken?.evidence.driverGone === false ? taken.why : theirs.why;
  }
  const [settled] = settleOwnDrives([silent], records, claims, own);
  return settled?.evidence.driverGone === false ? settled.why : null;
}
