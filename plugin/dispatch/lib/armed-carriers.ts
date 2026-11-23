/**
 * The stall watch's carriers as the plan reads them beside the launches:
 * an `unarmed` drive carries its item while the tick is about to arm it,
 * but not once a launch armed it at its head and ended without leaving a
 * drive ledger (a refusal, a crash). Such a drive is not armed again until
 * its head moves, and the drive's own row is only a quiet line, so the
 * item's stall need is what reports it, with the hold's reason.
 */
import { driveHold } from "./actions/drive-hold.ts";
import type { CarrierInput } from "./carried-pr.ts";
import type { PlanInput } from "./plan.ts";
import { foreignHold } from "./shared-launches.ts";

/** Why an unarmed drive's arm at its head already ran, on this host or another's; `null` when none did. */
function armedAlready(input: PlanInput, number: number): string | null {
  const pr = input.drives.find((d) => d.number === number);
  if (pr === undefined) return null;
  const own = driveHold(pr, input.launches);
  if (own.kind === "armed") return own.why;
  // As the plan reads a drive: another host's claims count only where none of this host's launches holds it.
  if (own.kind !== "none") return null;
  const claims = input.shared?.drives.get(number);
  if (input.shared === undefined || claims === undefined) return null;
  const foreign = foreignHold(pr, claims, input.shared.host);
  return foreign.kind === "armed" ? foreign.why : null;
}

/** `input` with its carriers reading an unarmed drive already armed at its head as no drive. */
export function withArmedHolds(input: PlanInput): PlanInput {
  const prOpen = input.prOpen;
  const carried = prOpen?.carried;
  if (prOpen === undefined || carried === undefined) return input;
  const drive: CarrierInput["drive"] = (pr) => {
    const read = carried.drive(pr);
    if (read.kind !== "unarmed") return read;
    const why = armedAlready(input, pr);
    return why === null ? read : { kind: "none", why };
  };
  return { ...input, prOpen: { ...prOpen, carried: { ...carried, drive } } };
}
