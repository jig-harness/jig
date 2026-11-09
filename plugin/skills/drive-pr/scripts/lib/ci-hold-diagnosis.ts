/** Evidence shared by the drive doctor and operator status; diagnostics never mutate a hold. */
import { shellQuote } from "./cli.ts";

export interface CiHoldDiagnosis {
  driver: "alive" | "dead" | "unknown";
  driverReason: string;
  head: string | null;
  label: string | null;
  held: boolean | null;
  review: "converged" | "pending" | "unknown";
  worktree: string | null;
  actor?: string | null;
  started?: string | null;
  generation?: number | null;
  ledgerGeneration?: number | null;
  readFailure?: string;
  worktreeReason?: string;
  reason: string;
  recovery: string | null;
}

export interface CiHoldEvidence
  extends Omit<CiHoldDiagnosis, "reason" | "recovery"> {
  worktreeSafe: boolean;
  ownership: boolean;
  transitionId?: string | null;
  parked: number | null;
  pr: string;
  releaseScript: string;
}

export function diagnoseCiHold(e: CiHoldEvidence): CiHoldDiagnosis {
  const missing: string[] = [];
  if (e.readFailure !== undefined) missing.push(e.readFailure);
  if (e.driver === "alive") missing.push("a driver is still alive");
  if (e.driver === "unknown")
    missing.push(`driver liveness is unknown: ${e.driverReason}`);
  if (e.label === null)
    missing.push("the CI hold label configuration is unavailable");
  if (e.held === null) missing.push("the live CI hold label could not be read");
  if (e.held === false)
    missing.push("the CI hold label is absent; observe fresh CI separately");
  if (e.review !== "converged")
    missing.push("review convergence on the current head is not established");
  if (e.parked === null || e.parked > 0)
    missing.push("human decisions remain or could not be read");
  if (!e.transitionId)
    missing.push("the diagnosed CI hold transition is unavailable");
  if (!e.ownership) missing.push("CI hold ownership is not established");
  const unsafeWorktree = worktreeFailure(e);
  if (unsafeWorktree !== null) missing.push(unsafeWorktree);
  if (e.head === null) missing.push("the expected head could not be read");
  const {
    worktreeSafe: _safe,
    ownership: _ownership,
    parked: _parked,
    pr: _pr,
    releaseScript: _script,
    transitionId: _transition,
    ...visible
  } = e;
  return {
    ...visible,
    reason:
      missing.length > 0
        ? missing.join("; ")
        : `review converged on ${e.head}; stopped driver left '${e.label}' blocking full CI; release the CI hold to start full CI (CI success is not established)`,
    recovery: releaseCommand(e, missing.length > 0),
  };
}

function worktreeFailure(e: CiHoldEvidence): string | null {
  if (e.worktreeSafe && e.worktree !== null) return null;
  return (
    e.worktreeReason ??
    "a clean worktree on the expected PR head is not established"
  );
}

function releaseCommand(e: CiHoldEvidence, blocked: boolean): string | null {
  if (blocked || e.worktree === null || e.head === null) return null;
  return `cd ${shellQuote(e.worktree)} && bun ${shellQuote(e.releaseScript)} release ${shellQuote(e.pr)} --expect-head ${shellQuote(e.head)} --expect-transition ${shellQuote(e.transitionId ?? "")}`;
}
