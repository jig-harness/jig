/**
 * What the doctor's local reading of a drive's CI hold adds to the station: the
 * wait that names a stranded hold's guarded recovery or a missing probe, the
 * detail that keeps a ledger's claim apart from what a probe established, and
 * whether the probe proves the writer of the ledger stopped.
 */
import type { CiHoldDiagnosis } from "../../skills/drive-pr/scripts/lib/ci-hold-diagnosis.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { type Holder, personWait, type WaitsOn } from "./answer.ts";
import type { PullDoc } from "./forge.ts";
import type { DriveRow } from "./local.ts";

/** The doctor names a stranded hold's guarded recovery; an unproven running ledger names a missing probe, or the launch whose hold on it outlived its bound (`held`). */
export function diagnosticWait(
  row: DriveRow | null,
  ledger: Ledger | null,
  doc: PullDoc,
  holder: Holder | "none",
  held: WaitsOn | null,
): WaitsOn | null {
  if (ledger !== null && ledger.parked.length > 0) return null;
  const diagnosis = row?.doctor?.ciHold;
  const strandedHold =
    held !== null && (holder === "none" || holder.process !== "alive");
  if (strandedHold) return withDiagnosis(held, diagnosis);
  if (diagnosis !== undefined && diagnosis.held !== false) {
    return holdWait(
      diagnosis,
      sameDriver(row, ledger),
      doc.head,
      holder === "none",
    );
  }
  if (
    ledger?.driver.state === "running" &&
    (holder === "none" || holder.process !== "alive")
  ) {
    return {
      waiting:
        diagnosis?.driver === "dead"
          ? `the local driver stopped while its ledger still reports running; ${diagnosis.driverReason}; inspect the drive doctor before re-arming`
          : "the ledger reports running, but driver liveness and ownership are unknown; inspect the owning driver's process or drive doctor",
    };
  }
  return null;
}

/** A stranded launch's wait, with what the doctor reads of the CI hold kept as supporting detail. */
function withDiagnosis(
  held: WaitsOn,
  diagnosis: CiHoldDiagnosis | undefined,
): WaitsOn {
  if (held === "none" || diagnosis === undefined || diagnosis.held === false)
    return held;
  const more = `the doctor also reads: ${diagnosis.driverReason}; ${diagnosis.reason}`;
  return "waiting" in held
    ? { waiting: `${held.waiting}; ${more}` }
    : { ...held, why: `${held.why}; ${more}` };
}

/** The shared diagnosis supplies the release proof; these reads must still describe the same run and head. */
function holdWait(
  diagnosis: CiHoldDiagnosis,
  matched: boolean,
  head: string,
  unheld: boolean,
): WaitsOn {
  const reason = `${diagnosis.driverReason}; ${diagnosis.reason}`;
  const current = diagnosis.head === head;
  if (
    matched &&
    current &&
    unheld &&
    diagnosis.recovery !== null &&
    diagnosis.driver === "dead" &&
    diagnosis.review === "converged"
  )
    return personWait(
      "release the CI hold",
      `${reason}; recovery: ${diagnosis.recovery}; this starts full CI, whose success remains to be checked`,
    );
  const missing = [reason];
  if (!matched)
    missing.push(
      "the local diagnosis does not identify the ledger writer, so ownership remains unknown",
    );
  if (!current)
    missing.push(
      "the diagnosis does not establish the current pull request head",
    );
  return { waiting: missing.join("; ") };
}

/** Only an identified stopped run with no active holder can override its ledger. */
export function locallyStopped(
  row: DriveRow | null,
  ledger: Ledger | null,
  holder: Holder | "none",
): boolean {
  return (
    sameDriver(row, ledger) &&
    row?.doctor?.ciHold?.driver === "dead" &&
    holder === "none"
  );
}

/** A process probe applies only to the run that wrote the forge ledger. */
export function sameDriver(
  row: DriveRow | null,
  ledger: Ledger | null,
): boolean {
  const diagnosis = row?.doctor?.ciHold;
  return (
    ledger !== null &&
    diagnosis !== undefined &&
    typeof diagnosis.actor === "string" &&
    diagnosis.actor === ledger.driver.actor &&
    typeof diagnosis.started === "string" &&
    diagnosis.started === ledger.driver.started &&
    diagnosis.ledgerGeneration === ledger.generation
  );
}

/** Separate what the ledger reports from what a local probe has established. */
export function diagnosticDetail(
  row: DriveRow | null,
  ledger: Ledger | null,
  holder: Holder | "none",
): string[] {
  const detail: string[] = [];
  if (
    ledger?.driver.state === "running" &&
    (holder === "none" || holder.process !== "alive")
  )
    detail.push(
      "ledger reports running, but process liveness is not established by that ledger",
    );
  const diagnosis = row?.doctor?.ciHold;
  if (diagnosis !== undefined)
    detail.push(diagnosis.driverReason, diagnosis.reason);
  return detail;
}
