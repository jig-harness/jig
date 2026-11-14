/**
 * Whether the tick may run again a follow-up the host failed (its pass died,
 * or its result or exit could not be written): only while the host's health
 * check passes, by the same verdict `jig doctor dispatch` reports for the
 * dispatcher's last run (`runtime/last-run.ts`). A tick writes its receipt
 * when it ends, so the run read is the tick before this one; a host with no
 * receipt yet has failed nothing.
 *
 * While the check fails, every death of this host's follow-ups that is not
 * itself a run again, whatever its age, and every unwritten result is held as
 * it stands: its marker is not released, nothing is run again, and no failed
 * follow-up is notified. What a person sees is the host's own need, the
 * `ticks-failing` or `repository-failing` notice of the cause
 * (`failure-notices.ts`). Once the check passes, a death's age window, the
 * session lease, applies again: a plain death older than it goes to a person.
 */
import { lastRunCheck } from "../../runtime/last-run.ts";
import { lastTick, stateRoot } from "../receipts.ts";

/** Why runs again of the host's failures are held now, from the health check's verdict; `null` while it passes. */
export function rerunsHeld(root = stateRoot()): string | null {
  const check = lastRunCheck("dispatch", lastTick(root));
  return check.status === "fail"
    ? `the host's health check fails (dispatch:last-run: ${check.detail})`
    : null;
}
