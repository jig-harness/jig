/**
 * The stale ledgers a re-drive settles once per change, after which a
 * person does: a stop on a conflict, an unclean tree, a stall, a spent CI-repair budget, a
 * pass deadline, a failure on a conflicting pull request, and, once per stop
 * after its backoff, an infrastructure failure that persisted. This machine's
 * launch records settle them in `actions/drive-hold.ts`, another host's
 * launch claims in `shared-launches.ts`, both in these words.
 */
import { conflictNote } from "./sources/ledgers.ts";
import type { DrivenPr, StaleCause } from "./types.ts";

/**
 * Whether a stale ledger is re-driven once per change and then a person's:
 * a stop on a conflict, an unclean tree, a stall, a spent CI-repair budget, a pass deadline,
 * an infrastructure failure that persisted, a failure on a conflicting pull
 * request. A converged one is only reported
 * once re-driven.
 */
export function settlesWithPerson(stale: StaleCause | undefined): boolean {
  return (
    stale?.conflictStop === true ||
    stale?.uncleanTree === true ||
    stale?.mechanicalStop !== undefined
  );
}

/** Why a ledger re-driven once at its change is now a person's: what stopped it, `by` the re-drive and how that ended, and until when. */
export function settledWhy(pr: DrivenPr, by: string): string {
  const until =
    pr.stale?.conflictStop === true
      ? "its head or its base moves"
      : "its head moves";
  const stopped =
    pr.stale?.conflictStop === true && pr.stale.recovery !== true
      ? "stopped on a conflict with its base"
      : `${pr.stale?.cause ?? pr.why}`;
  const conflict =
    pr.stale?.conflictStop === true ? "" : conflictNote(pr.evidence.mergeable);
  return `${stopped}, and ${by}: only a person settles it until ${until}${conflict} (see the drive's handoff)`;
}
