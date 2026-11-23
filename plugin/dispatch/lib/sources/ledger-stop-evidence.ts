import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Evidence } from "../types.ts";
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
      mergeable === "CONFLICTING")
  );
}

/** What a stop's evidence adds: the heads and the mergeability a ledger whose stop the forge's read places (`CONVERGED`, a conflict, a mechanical stop) was read beside. */
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
  if (ledger.driver.exit === DRIVE_EXIT.WORKTREE_UNCLEAN) return read;
  return baseRead === undefined ? {} : { ...baseRead, ...read };
}
