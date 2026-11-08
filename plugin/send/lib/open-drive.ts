/** Shared pull-request eligibility for commands that act on an open drive. */
import type { DriveReading } from "../../ask/lib/drive.ts";
import type { PullDoc } from "../../ask/lib/forge.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import { refused } from "./plan.ts";

export function openDrive(
  d: DriveReading,
  pr: string | number,
  closedReason: string,
): Outcome<PullDoc, "refused"> {
  if (d.pull === null) return refused(d.answer.stateDetail);
  const { doc, read } = d.pull;
  if (!read)
    return refused(
      `pull request ${pr} did not read, so whether it is open is not known`,
    );
  if (doc.state !== "OPEN")
    return refused(
      `pull request ${pr} is ${doc.state.toLowerCase()}: ${closedReason}`,
    );
  return ok(doc);
}
