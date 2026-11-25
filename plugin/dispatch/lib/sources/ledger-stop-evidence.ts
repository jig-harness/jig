import type { lastStopEvent } from "../../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Evidence, StaleCause } from "../types.ts";
import { stoppedOnProbeRead } from "./ledger-probe.ts";
import type { PrFacts } from "./ledgers.ts";

/** Read the base head for conflict stops and other stops that owe conflict recovery. */
export function readsBaseHead(
  ledger: Ledger,
  mergeable: string | null | undefined,
): boolean {
  if (ledger.driver.state !== "stopped") return false;
  const exit = ledger.driver.exit;
  return (
    exit === DRIVE_EXIT.PR_CONFLICTING ||
    (exit === DRIVE_EXIT.CONVERGED && mergeable === "CONFLICTING") ||
    (exit === DRIVE_EXIT.HITL_PARKED && mergeable === "CONFLICTING") ||
    (exit === DRIVE_EXIT.INDETERMINATE &&
      ledger.driver.personStop === undefined &&
      !stoppedOnProbeRead(ledger) &&
      mergeable === "CONFLICTING")
  );
}

/** What a stop's evidence adds: the heads and the mergeability a ledger whose stop the forge's read places (`CONVERGED`, a conflict, a mechanical stop) was read beside, and the head a `NOT_SETTLED` stop's repeated re-arms are counted on (`repeated-ends.ts`). */
export function stopEvidence(
  ledger: Ledger,
  forge: PrFacts,
  mechanical: boolean,
): Evidence {
  if (ledger.driver.state !== "stopped") return {};
  const read = { headSha: forge.head, mergeable: forge.mergeable };
  const { base } = forge;
  const baseRead = readsBaseHead(ledger, forge.mergeable)
    ? { baseSha: base !== undefined && "oid" in base ? base.oid : null }
    : undefined;
  if (mechanical) return read;
  if (ledger.driver.exit === DRIVE_EXIT.CONVERGED)
    return {
      verifiedSha: ledger.verifiedSha === "" ? null : ledger.verifiedSha,
      ...(ledger.reviewCarriedFrom === undefined
        ? {}
        : { reviewCarriedFrom: ledger.reviewCarriedFrom }),
      ...baseRead,
      ...read,
    };
  if (
    ledger.driver.exit === DRIVE_EXIT.WORKTREE_UNCLEAN ||
    ledger.driver.exit === DRIVE_EXIT.NOT_SETTLED
  )
    return read;
  return baseRead === undefined ? {} : { ...baseRead, ...read };
}

/**
 * Whether a mechanical stop's re-drive must run in the tree it stopped in: a
 * stall, listing or status probe read stop that left work there or never
 * measured it, and a pass deadline whose stop measured work left.
 */
export function boundToTree(
  kind: NonNullable<StaleCause["mechanicalStop"]>,
  exit: number,
  last: ReturnType<typeof lastStopEvent>,
): boolean {
  const own = last === undefined || last.cause === String(exit);
  if (kind === "stall" || kind === "check-runs" || kind === "probe-read")
    return own && last?.leftWork !== false;
  return kind === "deadline" && own && last?.leftWork === true;
}
