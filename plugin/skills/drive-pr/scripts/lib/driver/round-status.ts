/** Read the live round report and preview conflicts from positively measured dry-run evidence. */
import type { DriveRoundContext } from "./round-context.ts";

import { conflictRepairRounds } from "./settings.ts";

import { run, tsArgv } from "./../proc.ts";

import { driveStatus } from "./paths.ts";

async function previewConflictingRound(
  status: Record<string, unknown>,
  context: DriveRoundContext,
  reasonLine: string,
): Promise<number | "continue" | null> {
  const merge = (status.merge ?? {}) as Record<string, unknown>;
  const work = (status.work ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const unresolvedThreads = num(work.unresolvedThreads);
  const parkedThreads = num(work.parkedThreads);
  const summaryUnaddressed = num(work.summaryUnaddressed);
  const parkedSummaryFindings = num(work.parkedSummaryFindings);
  if (
    merge.mergeable === "CONFLICTING" &&
    unresolvedThreads !== null &&
    parkedThreads !== null &&
    summaryUnaddressed !== null &&
    parkedSummaryFindings !== null &&
    unresolvedThreads - parkedThreads <= 0 &&
    summaryUnaddressed - parkedSummaryFindings <= 0
  ) {
    const base = String(
      (status.base as Record<string, unknown> | undefined)?.refName ?? "",
    );
    // Mirror case 9's own budget check (`context.conflictRepairs < conflictBudget`
    // further below) instead of always previewing a repair pass: this
    // shortcut returns before `conflictRepairs` could ever be
    // incremented, so it is always comparing against a fresh 0, which
    // collapses the same comparison to "is the budget positive". Without
    // this, `DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0` still previewed "would
    // run a conflict-resolution pass" even though the real,
    // non-dry-run path takes the manual exit-9 stop instead.
    const conflictBudget = conflictRepairRounds();
    if (base === "") {
      console.error(
        "(dry-run) PR is conflicting with nothing left to work, but the base ref could not be read",
      );
    } else if (conflictBudget > 0) {
      console.error(
        `(dry-run) would run a conflict-resolution pass against origin/${base}`,
      );
    } else {
      console.error(
        `PR #${context.pr} conflicts with its base and has nothing left to work — stopping.`,
      );
      console.error(reasonLine);
      console.error(
        `  Fix: bun "<skill-dir>/../../shared/command.ts" -- git fetch origin; after success, bun "<skill-dir>/../../shared/command.ts" -- git merge origin/${base}, resolve, run the gates, push. (DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0 disables the automated repair pass)`,
      );
    }
    return 9;
  }

  return null;
}

export async function readRoundStatus(
  context: DriveRoundContext,
  forward: string[],
  probeFlags: string[],
): Promise<
  | number
  | "continue"
  | { code: number; status: Record<string, unknown>; reasonLine: string }
> {
  const inherited =
    context.inheritedHead === ""
      ? []
      : ["--inherited-head", context.inheritedHead];
  const statusRes = await run(
    tsArgv(driveStatus, [
      context.pr,
      "--json",
      ...forward,
      ...probeFlags,
      ...inherited,
    ]),
    { stderr: "inherit" },
  );
  const code = statusRes.code;
  let status: Record<string, unknown> = {};
  try {
    status = JSON.parse(statusRes.stdout) as Record<string, unknown>;
  } catch {
    status = {};
  }
  const reasonLine = `  ${String(status.reason ?? "")}`;
  // A directive may have arrived during drive-status.ts's long poll. Re-gate
  // after a resumed pause so its pre-pause snapshot cannot authorize work.
  const mailboxAfterStatus = await context.mailboxCheckpoint();
  if (typeof mailboxAfterStatus === "number") return mailboxAfterStatus;
  if (mailboxAfterStatus === "resumed") return "continue";

  // A dry run can NEVER see the real `code === 9` (PR_CONFLICTING)
  // certification: `--no-count` — part of every dry-run probe's
  // `probeFlags`, unconditionally — suppresses the replied-thread
  // reconciliation sweep, and `UNRECONCILED_STOPPERS` (`drive-status.ts`)
  // withholds code 9 until that sweep has run and succeeded, degrading to
  // INDETERMINATE (1) instead regardless of `--once`. That silently made
  // case 9's own dry-run preview below dead code, contradicting
  // README.md's "`--dry-run` reports what each round would do".
  // Recognise the SAME condition `evaluate()` uses to decide
  // PR_CONFLICTING — mergeable === 'CONFLICTING' and nothing LIVE left to
  // work — directly off this already-fetched report instead: the counts
  // below come from a plain, non-mutating enumeration, not from the
  // reconciliation sweep dry-run suppresses, so reading them here mutates
  // nothing and needs no certification. Every field must be a POSITIVELY
  // measured number, never a null (unmeasured) treated as zero — an
  // uncertain read must fall through to the honest INDETERMINATE below,
  // not manufacture a preview from a guess.
  if (context.dryRun) {
    {
      const stage = await previewConflictingRound(status, context, reasonLine);
      if (stage !== null) return stage;
    }
  }

  return { code, status, reasonLine };
}
