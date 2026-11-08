/**
 * What the repository clone's drive doctor reads of each pull request's lock
 * holder: `drives.ts --json` run in the clone, read-only, whose pull-request
 * rows carry the doctor's verdict (`lib/doctor.ts`). The re-arm stage reads
 * it for a drive whose ledger fell silent past the lease window and whose
 * driver no launch record or launch claim started: such a driver is taken
 * over when the doctor reads its holder `DEAD` or `WEDGED`, and reported
 * otherwise. `drive.ts --take-over` checks the holder again and has the final
 * word.
 *
 * `$JIG_DISPATCH_DOCTOR_SCRIPT` replaces `drives.ts` for the suite, as
 * `$JIG_DISPATCH_DRIVE_SCRIPT` replaces `drive.ts`.
 */
import { drives } from "../../../skills/drive-pr/scripts/lib/driver/paths.ts";
import { isRecord } from "../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { run, tsArgv } from "../../../shared/proc.ts";
import { failureText } from "../text.ts";
import type { DrivenPr, HolderReading } from "../types.ts";

/** Each pull request's holder as the doctor reads it, or why the doctor could not be read. */
export type HolderReadings = Outcome<
  ReadonlyMap<number, HolderReading>,
  "unreadable"
>;

/** The doctor verdicts whose holder a takeover replaces. */
const REPLACEABLE: ReadonlySet<string> = new Set(["DEAD", "WEDGED"]);

/** The pull-request rows of `drives.ts --json`'s output, by number. */
export function parseHolders(stdout: string): HolderReadings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return failed(
      "unreadable",
      `its output is not JSON: ${failureText(error)}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rows))
    return failed("unreadable", "its output holds no rows");
  const holders = new Map<number, HolderReading>();
  for (const row of parsed.rows) {
    if (!isRecord(row) || row.kind !== "pr" || typeof row.key !== "string")
      continue;
    const doctor = isRecord(row.doctor) ? row.doctor : null;
    holders.set(Number(row.key), {
      verdict: typeof doctor?.verdict === "string" ? doctor.verdict : "UNKNOWN",
      reason:
        typeof doctor?.reason === "string" ? doctor.reason : "not classified",
      lock: typeof row.state === "string" ? row.state : "unreadable",
    });
  }
  return ok(holders);
}

/** Run the doctor in the repository's clone, within `timeoutSec`. */
export async function readHolders(
  repoPath: string,
  timeoutSec: number,
): Promise<HolderReadings> {
  const script = process.env.JIG_DISPATCH_DOCTOR_SCRIPT || drives;
  try {
    const r = await run(tsArgv(script, ["--json"]), {
      cwd: repoPath,
      stderr: "pipe",
      timeoutSec,
    });
    if (r.code !== 0)
      return failed(
        "unreadable",
        `drives.ts --json exited ${r.code}${r.stderr.trim() === "" ? "" : `: ${r.stderr.trim().split("\n").at(-1)}`}`,
      );
    return parseHolders(r.stdout);
  } catch (error) {
    return failed("unreadable", failureText(error));
  }
}

/**
 * A silent drive no launch started, read beside the doctor: the holder its
 * takeover replaces, or why it is reported instead.
 */
export function orphanTakeover(
  pr: DrivenPr,
  holders: HolderReadings | undefined,
): { holder: HolderReading } | { why: string } {
  const none = `${pr.why}; no launch record of this machine or launch claim of another host started its driver`;
  if (holders === undefined)
    return {
      why: `${none}, and this clone's drive doctor was not read, so it is reported, not taken over`,
    };
  if (!holders.ok)
    return {
      why: `${none}, and this clone's drive doctor could not be read (${holders.failure.reason}), so it is reported, not taken over`,
    };
  const holder = holders.value.get(pr.number);
  if (holder === undefined || holder.lock === "empty")
    return {
      why: `${none}, and no driver of this clone holds its lock (its driver ran in another clone, which this host's doctor cannot read), so it is reported, not taken over`,
    };
  if (REPLACEABLE.has(holder.verdict)) return { holder };
  return {
    why: `${none}, and this clone's drive doctor reads its holder ${holder.verdict} (${holder.reason}): only a dead or wedged holder is taken over, so it is reported`,
  };
}
