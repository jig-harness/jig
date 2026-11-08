/**
 * Whether a dispatcher still takes over a silent drive whose driver this host
 * shows gone, as the tick reads it beside this machine's launch records,
 * other hosts' launch claims and the pull request's recovery budget.
 */
import { settleSilentTakeovers } from "../../dispatch/lib/actions/drive-hold.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import { settleNoCauseStops } from "../../dispatch/lib/no-cause-stops.ts";
import { foreignHold } from "../../dispatch/lib/shared-launches.ts";
import {
  classifyLedger,
  type ParkReading,
  type PrFacts,
} from "../../dispatch/lib/sources/ledgers.ts";
import { stallThresholdMs } from "../../skills/drive-pr/scripts/lib/doctor.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import type { PullDoc } from "./forge.ts";

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
    Date.now(),
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
  const claims = new Map([
    [pull.number, { ok: true as const, value: sharedClaims }],
  ]);
  const [own] = settleSilentTakeovers([silent], records);
  if (own?.evidence.driverGone === false) return own.why;
  const hold = foreignHold(silent, claims.get(pull.number), host ?? "");
  if (hold.kind === "refused") return hold.why;
  if (hold.kind !== "none") return null;
  const [budget] = settleNoCauseStops(
    [{ ...silent, evidence: { ...silent.evidence, unlaunched: true } }],
    records,
    claims,
    Date.now(),
  );
  return budget?.evidence.driverGone === false ? budget.why : null;
}
