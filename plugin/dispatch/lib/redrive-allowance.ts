/**
 * The stops the repository's re-drive allowance (`redrive-config.ts`) hands
 * to a person that neither this host's launch records nor another host's
 * claims spent alone: an allowance of `0`, which no re-drive spends, and an
 * allowance spent between this host's re-drives and another's at one change.
 * A stop a launch still holds, or that either source alone settles, reads as
 * those say.
 */
import { changesOf, winners } from "../../shared/records/shared.ts";
import {
  driveHold,
  ownRedrives,
  settledConflict,
} from "./actions/drive-hold.ts";
import { endedOnLimit } from "./forge-limit-redrive.ts";
import type { ReadRecord } from "./launches.ts";
import { redriveKind, redrivesAllowed } from "./redrive-config.ts";
import { type DriveClaims, foreignHold } from "./shared-launches.ts";
import type { DrivenPr } from "./types.ts";

/** How many times another host re-drove a stale ledger for the change it shows now; a launch the forge's limit stopped spent none. */
function foreignRedrives(
  pr: DrivenPr,
  claims: DriveClaims,
  host: string,
): number {
  const read = claims.get(pr.number);
  const change = pr.stale?.change;
  if (read === undefined || !read.ok || change === undefined) return 0;
  return winners(read.value).filter((c) => {
    const says = c.says.value;
    return (
      says.host !== host &&
      !(says.end?.state === "ended" && endedOnLimit(says.end.exit)) &&
      changesOf(says).includes(change)
    );
  }).length;
}

/** Each drive whose re-drives allowed at the change it shows now are spent across every host, or are none: a person's. */
export function settleRedriveAllowance(
  drives: readonly DrivenPr[],
  own: ReadRecord[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  return drives.map((pr) => {
    const kind = redriveKind(pr.stale);
    if (pr.class !== "stale" || pr.stale === undefined || kind === null)
      return pr;
    if (
      driveHold(pr, own).kind !== "none" ||
      foreignHold(pr, claims.get(pr.number), host).kind !== "none"
    )
      return pr;
    const allowed = redrivesAllowed(pr.stale);
    const made = ownRedrives(pr, own) + foreignRedrives(pr, claims, host);
    if (made < allowed) return pr;
    return settledConflict(
      pr,
      made === 0
        ? `no re-drive of it is allowed (dispatch.redrive.${kind}, capped by this host's redrive_max, is 0)`
        : `this host and another already re-drove it ${made} times for this change, the most its repository allows`,
    );
  });
}
