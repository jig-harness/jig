/**
 * The structural-churn brake, as drive-status runs it: after a counting
 * `ROUND_READY` gate has recorded the round's evidence, judge it
 * (`state/churn.ts`) and, when it trips, park the drive under the
 * `structural-churn` class with a framed decision (`state/churn-decision.ts`)
 * and end the gate `HITL_PARKED` before the round's pass runs.
 *
 * A failure is never a silent pass: an unreadable setting, an unreadable
 * state or a park that did not land ends the gate `INDETERMINATE`, so the
 * driver runs it again rather than spending a round the brake should have
 * stopped.
 *
 * Its setting, `drive.churn_rounds` (`DRIVE_PR_CHURN_ROUNDS` overrides it
 * for one run), is how many consecutive rounds make a same-file streak; `0`
 * turns the brake off, oscillation included.
 */
import { configSource } from "../../../../../shared/consumer.ts";
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../../shared/outcome.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { readOptionalOverlay } from "../overlay.ts";
import { run, tsArgv } from "../proc.ts";
import {
  CHURN_CLASS,
  type ChurnEvidence,
  type ChurnTrip,
  churnKey,
  DEFAULT_CHURN_ROUNDS,
  MAX_CHURN_ROUNDS,
  MIN_CHURN_ROUNDS,
  structuralChurn,
} from "../state/churn.ts";
import { churnDecision, churnWhat } from "../state/churn-decision.ts";
import { terminal } from "./terminal-states.ts";

/** The environment variable that overrides `drive.churn_rounds` for one run. */
export const CHURN_ROUNDS_VARIABLE = "DRIVE_PR_CHURN_ROUNDS";

const RANGE = `0 (off) or a whole number from ${MIN_CHURN_ROUNDS} to ${MAX_CHURN_ROUNDS}`;

function inRange(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isSafeInteger(n) &&
    (n === 0 || (n >= MIN_CHURN_ROUNDS && n <= MAX_CHURN_ROUNDS))
  );
}

/**
 * The brake's round count: `DRIVE_PR_CHURN_ROUNDS` when set, else
 * `drive.churn_rounds`, else the default. A value outside the range is a
 * failure, never a quiet default: a typo must not turn the brake off.
 */
export function churnRoundsSetting(
  env: Record<string, string | undefined> = process.env,
): Outcome<number, "churn-rounds-invalid"> {
  const raw = env[CHURN_ROUNDS_VARIABLE];
  if (raw !== undefined && raw.trim() !== "") {
    const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    return inRange(n)
      ? ok(n)
      : failed(
          "churn-rounds-invalid",
          `${CHURN_ROUNDS_VARIABLE} must be ${RANGE} (got '${raw}')`,
        );
  }
  const read = attempt(
    "churn-rounds-invalid",
    "cannot read the repository's configuration",
    readOptionalOverlay,
  );
  if (!read.ok) return read;
  const drive = read.value.drive;
  const value = isRecord(drive) ? drive.churn_rounds : undefined;
  if (value === undefined || value === null) return ok(DEFAULT_CHURN_ROUNDS);
  return inRange(value)
    ? ok(value)
    : failed(
        "churn-rounds-invalid",
        `drive.churn_rounds must be ${RANGE}: ${configSource("drive.churn_rounds")}`,
      );
}

/** What tripped the brake, for a reason line. */
export function describeTrip(trip: ChurnTrip): string {
  const files = trip.paths.slice(0, 5).join(", ");
  const more =
    trip.paths.length > 5 ? ` and ${trip.paths.length - 5} more` : "";
  return `structural churn (${trip.kind}): ${files}${more} ${churnWhat(trip.kind)} in rounds ${trip.rounds.join(", ")}`;
}

/**
 * The `HITL_PARKED` reason while the drive's own structural-churn park
 * stands, whatever work is live; `null` when there is none.
 */
export function churnParkReason(
  selfParked: ReadonlySet<string>,
): string | null {
  if (selfParked.size === 0) return null;
  const keys = [...selfParked].sort().join(", ");
  return `the drive parked itself on structural churn (${keys}) and holds the live work until a person answers that decision — answer it, then re-arm`;
}

interface BrakeContext {
  pr: string;
  driveStateScript: string;
  helperTimeoutSec: number;
}

interface BrakeReport {
  state: string;
  reason: string;
  parkedItemKeys: string[] | null;
  actionableParkKeys: string[] | null;
}

function indeterminate(report: BrakeReport, reason: string): number {
  report.state = "INDETERMINATE";
  report.reason = reason;
  return 1;
}

/** The judged state, or why it could not be read. */
async function readEvidence(
  ctx: BrakeContext,
): Promise<Outcome<ChurnEvidence & { rounds: number }>> {
  const r = await run(tsArgv(ctx.driveStateScript, ["get", ctx.pr]), {
    stderr: "pipe",
    timeoutSec: ctx.helperTimeoutSec,
  });
  if (r.code !== 0)
    return failed("state-unreadable", `drive-state get exited ${r.code}`);
  const parsed = attempt("state-unreadable", "drive-state get printed", () =>
    JSON.parse(r.stdout),
  );
  if (!parsed.ok) return parsed;
  const value: unknown = parsed.value;
  if (!isRecord(value) || typeof value.rounds !== "number")
    return failed("state-unreadable", "drive-state get printed no round");
  return ok({ ...(value as ChurnEvidence), rounds: value.rounds });
}

/**
 * Judge the round just recorded and park the drive when it churns. Returns
 * the exit the gate ends with (`8` parked, `1` a failure), or `null` when
 * the round goes ahead.
 */
export async function runChurnBrake(
  ctx: BrakeContext,
  report: BrakeReport,
): Promise<number | null> {
  const setting = churnRoundsSetting();
  if (!setting.ok)
    return indeterminate(
      report,
      `cannot judge structural churn: ${setting.failure.reason}`,
    );
  const n = setting.value;
  if (n === 0) return null;
  const state = await readEvidence(ctx);
  if (!state.ok)
    return indeterminate(
      report,
      `cannot judge structural churn on #${ctx.pr}: ${state.failure.reason}`,
    );
  const trip = structuralChurn(state.value, { rounds: n });
  if (trip === null) return null;
  const round = state.value.rounds;
  const park = await run(
    tsArgv(ctx.driveStateScript, [
      "park-churn",
      ctx.pr,
      "--round",
      String(round),
      ...trip.paths.slice(0, 1).flatMap((p) => ["--path", p]),
    ]),
    {
      stdin: JSON.stringify(churnDecision(trip, ctx.pr, round, n)),
      stdout: "ignore",
      stderr: "pipe",
      timeoutSec: ctx.helperTimeoutSec,
    },
  );
  if (park.code !== 0) {
    if (park.stderr) process.stderr.write(park.stderr);
    return indeterminate(
      report,
      `${describeTrip(trip)}, but the ${CHURN_CLASS} park could not be recorded (park-churn exited ${park.code}); run the round again`,
    );
  }
  const key = churnKey(round);
  report.parkedItemKeys = [...(report.parkedItemKeys ?? []), key].sort();
  report.actionableParkKeys = [
    ...(report.actionableParkKeys ?? []),
    key,
  ].sort();
  return terminal(
    report,
    "HITL_PARKED",
    `${describeTrip(trip)}; the drive parked itself before round ${round}'s pass under ${CHURN_CLASS} (${key}): answer that decision, then re-arm`,
  );
}
