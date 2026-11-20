/**
 * Run by a test's pass as a script: leaves the finish record finish-round.ts
 * writes when the head's check-runs listing is cut short, through its own
 * writer, for the pull request and round the driver hands the pass. The
 * record is bound to the launch named as the first argument, else to the
 * pass's own (`JIG_LAUNCH`).
 */
import type { Report } from "../scripts/lib/finish-round-report.ts";
import { writePassFinish } from "../scripts/lib/state/pass-finish.ts";

/** The pages the listing read before it was cut short. */
export const LISTING_PAGES = 3;

if (import.meta.main) {
  const env = process.env;
  const report: Report = {
    state: "CHECK_RUNS_UNREADABLE",
    reason: "the check-runs listing was cut short",
    pushed: true,
    stamped: false,
    headSynced: false,
    items: [],
    listingPagesRead: LISTING_PAGES,
  };
  writePassFinish(
    env.DRIVE_PR_STATE_DIR ?? "",
    Number(env.DRIVE_PR_TARGET),
    process.argv[2] ?? env.JIG_LAUNCH ?? "",
    Number(env.DRIVE_PR_ROUND),
    report,
  );
}
