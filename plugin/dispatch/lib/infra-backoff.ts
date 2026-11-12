/**
 * The re-drive of a drive that stopped `CI_INFRA_PERSISTED` (exit `23`):
 * every failing check on its converged head had failed on the infrastructure
 * through the re-runs and head moves the drive spends on it, so no code
 * change settles it and the forge must recover first.
 *
 * Such a stop is `stale`, re-driven once per stop rather than once per head:
 * the drive's head moves may leave it on the head it stopped on before, and an
 * outage that clears is settled by the same drive run again. Each re-drive
 * waits out a backoff from the stop's time, doubling with every consecutive
 * such stop the ledger's events record (15 minutes, then 30, up to 4 hours);
 * once 6 consecutive re-drives have stopped the same way, it is a person's,
 * since a failure that outlasts them is no longer read as passing.
 */
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Classified } from "./sources/ledgers.ts";
import type { DrivenPr } from "./types.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";

const INFRA_BACKOFF_BASE_MS = 15 * 60_000;
const INFRA_BACKOFF_CAP_MS = 4 * 60 * 60_000;
/** The consecutive infrastructure stops re-driven before a person is told. */
export const INFRA_REDRIVES = 6;

/** The consecutive `CI_INFRA_PERSISTED` stops at the end of the ledger's stop events, and the last one's time. */
function infraStops(ledger: Ledger): { count: number; at: string } {
  const stops = (ledger.events ?? []).filter((e) => e.kind === "stop");
  let count = 0;
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i]?.cause !== String(DRIVE_EXIT.CI_INFRA_PERSISTED)) break;
    count += 1;
  }
  const last = stops.at(-1);
  return {
    count: Math.max(count, 1),
    at: count > 0 && last !== undefined ? last.at : ledger.driver.heartbeat,
  };
}

/** How long the `count`th consecutive infrastructure stop waits before its re-drive. */
function infraBackoffMs(count: number): number {
  const doubled = INFRA_BACKOFF_BASE_MS * 2 ** Math.max(count - 1, 0);
  return Math.min(doubled, INFRA_BACKOFF_CAP_MS);
}

/** A `CI_INFRA_PERSISTED` stop on `head`: stale once per stop, after its backoff; a person's past the re-drive bound. */
export function infraStopClass(
  ledger: Ledger,
  exit: number,
  head: string,
  words: string,
): Classified {
  const { count, at } = infraStops(ledger);
  if (count > INFRA_REDRIVES)
    return {
      class: "needs-person",
      why: `stopped ${exit} (${words}) ${count} times in a row, its last ${INFRA_REDRIVES} re-drives included: the infrastructure has not recovered, so a person settles it (see the drive's handoff)`,
    };
  const stoppedMs = parseMs(at);
  const notBefore = isoFromMs(
    (Number.isFinite(stoppedMs) ? stoppedMs : 0) + infraBackoffMs(count),
  );
  return {
    class: "stale",
    why: `stopped ${exit} (${words}), stop ${count} of ${INFRA_REDRIVES + 1} in a row: re-drive on any account from ${notBefore}`,
    stale: {
      cause: `stopped ${exit}, ${words}`,
      change: `head ${head}, stopped ${exit} at ${at}`,
      mechanicalStop: "ci-infra",
      notBefore,
    },
  };
}

/** Why a stale drive is not re-driven yet: its backoff has not ended. `null` once it has, or for any other drive. */
export function backingOff(pr: DrivenPr, nowMs: number): string | null {
  const notBefore = pr.stale?.notBefore;
  if (pr.class !== "stale" || notBefore === undefined) return null;
  const at = parseMs(notBefore);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  return `${pr.why}; its backoff ends ${notBefore}, so it is not re-driven yet`;
}
