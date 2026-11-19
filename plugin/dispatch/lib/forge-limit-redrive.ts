/**
 * The re-drive of a drive that stopped `FORGE_RATE_LIMITED` (exit `24`): the
 * forge's rate limit for its credential was spent, with a reset further off
 * than the drive waits. Nothing about the pull request changed and nothing a
 * person does clears it sooner, so the stop is `stale`, re-driven once per
 * stop, on any account, from the reset its stop recorded (`until` on its
 * `stop` event), or an hour after the stop where it recorded none (the
 * longest window the forge's limits reset in). Until then the plan keeps it
 * quiet (`backingOff`).
 *
 * A launch the limit stopped before the drive wrote its ledger (its attach
 * read refused, or the ledger's own write) leaves the ledger as it was: it
 * spent no arm and no re-drive (`endedOnLimit`), and the next launch on
 * those facts waits an hour from its end (`drive-hold.ts`).
 */
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { lastStopEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Classified } from "./sources/ledgers.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";

/** How long after a stop that recorded no reset its re-drive waits. */
export const FORGE_LIMIT_FALLBACK_MS = 60 * 60_000;

/** Whether a launch ended on the forge's spent rate limit (`FORGE_RATE_LIMITED`). */
export function endedOnLimit(exit: number | null | undefined): boolean {
  return exit === DRIVE_EXIT.FORGE_RATE_LIMITED;
}

/** A `FORGE_RATE_LIMITED` stop on `head`: stale once per stop, from the limit's reset. */
export function forgeLimitStopClass(
  ledger: Ledger,
  exit: number,
  head: string,
  words: string,
): Classified {
  const last = lastStopEvent(ledger.events ?? []);
  const stop = last?.cause === String(exit) ? last : undefined;
  const at = stop?.at ?? ledger.driver.heartbeat;
  // The ledger's shape leaves the field open: a writer's value is read only
  // when it is an instant.
  const until: unknown = stop?.until;
  const recorded = typeof until === "string" ? parseMs(until) : Number.NaN;
  const stoppedMs = parseMs(at);
  const notBefore = isoFromMs(
    Number.isFinite(recorded)
      ? recorded
      : (Number.isFinite(stoppedMs) ? stoppedMs : 0) + FORGE_LIMIT_FALLBACK_MS,
  );
  const reset = Number.isFinite(recorded)
    ? `it resets ${notBefore}`
    : Number.isFinite(stoppedMs)
      ? `it recorded no reset, so an hour after the stop`
      : `it recorded no reset and its stop time does not read, so at once`;
  return {
    class: "stale",
    why: `stopped ${exit} (${words}; ${reset}): re-drive on any account from ${notBefore}`,
    stale: {
      cause: `stopped ${exit}, ${words}`,
      change: `head ${head}, stopped ${exit} at ${at}`,
      mechanicalStop: "forge-limit",
      notBefore,
    },
  };
}
