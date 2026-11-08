/**
 * The tags a launch's ledger facts carry when the launch draws on a pull
 * request's recovery budget (`no-cause-stops.ts`): a re-arm of a stop with no
 * recorded cause (`no-cause: `), and a re-drive of a stop whose next step is
 * mechanical (`recovery: `): a pass deadline, a failure on a conflicting pull
 * request, a silent driver this host shows gone, a follow-up whose session
 * died or that stopped on a routine question. Launch records and every
 * host's launch claims carry the facts, so the budget counts the attempts of
 * either kind from both.
 *
 * A `recovery: ` tag says how a launch is counted, not what the ledger said:
 * two facts that differ only by it act on the same ledger (`sameFacts`).
 */
import type { DrivenPr } from "./types.ts";

export const NO_CAUSE_FACTS = "no-cause: ";
export const RECOVERY_FACTS = "recovery: ";

/** Whether a launch acting on `facts` drew on its pull request's recovery budget. */
export function budgeted(facts: string): boolean {
  return facts.startsWith(NO_CAUSE_FACTS) || facts.startsWith(RECOVERY_FACTS);
}

/**
 * Whether a drive's launch is a re-drive the recovery budget counts: a stale
 * stop it marks so, or the takeover of a silent driver no launch started
 * (`unlaunched`) whose run this host shows ended. The takeover of a driver a
 * launch started is not counted.
 */
export function isRecovery(pr: DrivenPr): boolean {
  return pr.stale?.recovery === true || goneUnlaunched(pr);
}

/** Whether a silent drive's driver was started by no launch of any host, and this host shows its run ended. */
export function goneUnlaunched(pr: DrivenPr): boolean {
  return (
    pr.class === "silent" &&
    pr.evidence.driverGone === true &&
    pr.evidence.unlaunched === true
  );
}

/** `facts` without the recovery tag. */
function untagged(facts: string): string {
  return facts.startsWith(RECOVERY_FACTS)
    ? facts.slice(RECOVERY_FACTS.length)
    : facts;
}

/** Whether two launches' facts act on the same ledger, whether or not either drew on the recovery budget. */
export function sameFacts(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  return untagged(a) === untagged(b);
}
