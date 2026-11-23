/**
 * A stall whose passes all failed to push, read from its ledger: the
 * drive's last `stop` event records the `finish-round.ts` state every
 * stalled pass ended on (`finish`), and when that is `PUSH_FAILED` the stop
 * is a person's, never a mechanical re-drive. What refused the push (a
 * pre-push gate the base branch breaks, the remote) refuses a re-drive's
 * push too, so a re-drive would only spend another stall's passes on it.
 */
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { lastStopEvent } from "../../../skills/drive-pr/scripts/lib/state/events.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { LedgerClass } from "../types.ts";
import { conflictNote } from "./ledger-probe.ts";

/** The longest part of a push failure's reason a class's `why` quotes. */
const PUSH_REASON_QUOTED = 400;

/**
 * The class of a ledger that stopped `exit` on a stall whose every pass's
 * push failed: `needs-person`, naming why; `null` for any other stop.
 */
export function pushFailedStallClass(
  ledger: Ledger,
  exit: number,
  mergeable: unknown,
): { class: LedgerClass; why: string } | null {
  if (exit !== DRIVE_EXIT.STALLED) return null;
  const last = lastStopEvent(ledger.events ?? []);
  if (last?.cause !== String(exit) || last.finish?.state !== "PUSH_FAILED")
    return null;
  const reason = last.finish.reason.replace(/\s+/g, " ").trim();
  const quoted =
    reason.length > PUSH_REASON_QUOTED
      ? `${reason.slice(0, PUSH_REASON_QUOTED - 1)}…`
      : reason;
  return {
    class: "needs-person",
    why: `stopped ${exit} (stalled: every stalled pass's push failed: ${quoted}); a re-drive fails the same push, so fix what refuses it (the base branch first when its gates fail there too), then re-arm${conflictNote(mergeable)}`,
  };
}
