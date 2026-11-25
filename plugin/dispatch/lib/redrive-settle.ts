/**
 * The stale ledgers a re-drive settles once per change, after which a
 * person does: a stop on a conflict, an unclean tree, a stall, a spent
 * CI-repair budget, a pass deadline, a check-runs listing cut short, a
 * status probe read failure, a failure on a conflicting pull request, an infrastructure failure after its
 * backoff, or the forge's spent rate limit after its reset. This machine's
 * launch records settle them in `actions/drive-hold.ts`, another host's
 * launch claims in `shared-launches.ts`, both in these words.
 */
import { conflictNote } from "./sources/ledger-probe.ts";
import type { DrivenPr, StaleCause } from "./types.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";

/**
 * Whether a stale ledger is re-driven once per change and then a person's:
 * a stop on a conflict, an unclean tree, a mechanical stop, or a failure on a
 * conflicting pull request, including one whose drive converged.
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
  const kind = pr.stale?.mechanicalStop;
  const readFailure = kind === "check-runs" || kind === "probe-read";
  const detail =
    kind === "probe-read" && pr.evidence.probeReason
      ? ` (${pr.evidence.probeReason})`
      : "";
  const stopped =
    pr.evidence.exit === DRIVE_EXIT.PR_CONFLICTING
      ? "stopped on a conflict with its base"
      : `${readFailure ? "a systematic read failure: " : ""}${pr.stale?.cause ?? pr.why}${detail}`;
  const conflict =
    pr.stale?.conflictStop === true ? "" : conflictNote(pr.evidence.mergeable);
  return `${stopped}, and ${by}: only a person settles it until ${until}${conflict} (see the drive's handoff)`;
}
