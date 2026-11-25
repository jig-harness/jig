/**
 * The structural-churn brake, as drive-status runs it: after a counting
 * `ROUND_READY` gate has recorded the round's evidence, judge it
 * (`state/churn.ts`) and, when it trips, park the drive under the
 * `structural-churn` class with a framed decision (`state/churn-decision.ts`)
 * and end the gate `HITL_PARKED` before the round's pass runs.
 *
 * A failure is never a silent pass: an unreadable setting, an unreadable
 * state, a round whose evidence did not land, a trip before the replied-thread
 * sweep completed or a park that did not land ends the gate `INDETERMINATE`
 * (exit `1`). That exit ends `drive.ts`: the drive stops there and is re-armed
 * once the failure is addressed, rather than spending a round the brake
 * should have stopped.
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
import { readPolicySnapshot } from "../../../../../shared/autonomy.ts";
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
import { readPrSnapshot } from "./pr-snapshot.ts";

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
  // The repository's value comes from the policy the driver names (the base
  // branch's file at its commit), never from the pull request's own checkout:
  // the change being driven must not turn off its own brake. A person's
  // session reads the working tree, as for every autonomy setting.
  const policy = readPolicySnapshot(env);
  let values: Record<string, unknown>;
  if (policy.from === "unreadable")
    return failed(
      "churn-rounds-invalid",
      `the base branch's policy cannot be read (${policy.reason}), so drive.churn_rounds cannot be trusted`,
    );
  if (policy.from === "base") values = policy.values;
  else {
    const read = attempt(
      "churn-rounds-invalid",
      "cannot read the repository's configuration",
      readOptionalOverlay,
    );
    if (!read.ok) return read;
    values = read.value;
  }
  const own = valueIn(values);
  if (!own.ok || policy.from !== "base" || policy.bound === undefined)
    return own;
  // A stacked pull request's immediate base is itself unreviewed: the
  // integration branch's setting is the floor, and the base may only tighten
  // it. An integration branch with the brake off leaves the base's value.
  const floor = valueIn(policy.bound.values);
  if (!floor.ok) return floor;
  if (floor.value === 0) return own;
  return ok(own.value === 0 ? floor.value : Math.min(own.value, floor.value));
}

/** `drive.churn_rounds` as one policy file's values hold it. */
function valueIn(
  values: Record<string, unknown>,
): Outcome<number, "churn-rounds-invalid"> {
  if (!Object.hasOwn(values, "drive")) return ok(DEFAULT_CHURN_ROUNDS);
  const drive = values.drive;
  if (!isRecord(drive))
    return failed(
      "churn-rounds-invalid",
      `drive must be a mapping to hold drive.churn_rounds: ${configSource("drive.churn_rounds")}`,
    );
  const value = drive.churn_rounds;
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
 * What holds the drive while its own structural-churn park stands, whatever
 * work is live, for a `HITL_PARKED` or `PR_CONFLICTING` reason; `null` when
 * there is none.
 */
export function churnParkReason(
  selfParked: ReadonlySet<string>,
): string | null {
  if (selfParked.size === 0) return null;
  const keys = [...selfParked].sort().join(", ");
  return `the drive parked itself on structural churn (${keys}), which holds the live work until a person answers that decision`;
}

interface BrakeContext {
  pr: string;
  owner?: string;
  repo?: string;
  driveStateScript: string;
  helperTimeoutSec: number;
}

interface BrakeReport {
  state: string;
  reason: string;
  parkedItemKeys: string[] | null;
  actionableParkKeys: string[] | null;
  mergeable: string;
  mergeStateStatus: string;
  apiHead: string;
  baseRefName: string;
  baseHead?: string;
}

/** The last non-empty line of a child's error output, or `''`. */
function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .findLast((l) => l !== "") ?? ""
  );
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
  if (r.code !== 0) {
    if (r.stderr) process.stderr.write(r.stderr);
    const why = lastLine(r.stderr);
    return failed(
      "state-unreadable",
      `drive-state get exited ${r.code}${why === "" ? "" : `: ${why}`}`,
    );
  }
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
 * the exit the gate ends with (`8` parked, `9` parked on a pull request that
 * conflicts with its base, which is reported first as for any park, `1` a
 * failure), or `null` when the round goes ahead. `recorded` is whether this
 * round's evidence landed: judging a window missing the round could let the
 * round run that the brake should have stopped, so with the brake on an
 * unrecorded round ends the gate instead.
 */
export async function runChurnBrake(
  ctx: BrakeContext,
  report: BrakeReport,
  recorded: boolean,
  reconciled: boolean,
  env: Record<string, string | undefined> = process.env,
): Promise<number | null> {
  const setting = churnRoundsSetting(env);
  if (!setting.ok)
    return indeterminate(
      report,
      `cannot judge structural churn: ${setting.failure.reason}`,
    );
  const n = setting.value;
  if (n === 0) return null;
  if (!recorded)
    return indeterminate(
      report,
      `this round's structural-churn evidence could not be recorded for #${ctx.pr} (record-paths failed), so the brake cannot judge the round; re-arm the drive`,
    );
  const state = await readEvidence(ctx);
  if (!state.ok)
    return indeterminate(
      report,
      `cannot judge structural churn on #${ctx.pr}: ${state.failure.reason}`,
    );
  const trip = structuralChurn(state.value, { rounds: n });
  if (trip === null) return null;
  // A new park ends the drive, so it needs the replied-thread sweep behind
  // it, as every other verdict that ends one does.
  if (!reconciled)
    return indeterminate(
      report,
      `${describeTrip(trip)}, but the replied-thread reconciliation sweep did not complete on #${ctx.pr}, so the ${CHURN_CLASS} park is withheld; the drive stops here, so re-arm it for a counting pass`,
    );
  const round = state.value.rounds;
  // The verdict above was reached before the blob and state reads: park only
  // while the reviewed head and base are still the pull request's.
  if (ctx.owner !== undefined && ctx.repo !== undefined) {
    const now = await readPrSnapshot(
      ctx.owner,
      ctx.repo,
      ctx.pr,
      "still-on-head",
    );
    if (!now.ok)
      return indeterminate(
        report,
        `${describeTrip(trip)}, but #${ctx.pr}'s head and base could not be re-read before the park (${now.reason}); re-arm the drive`,
      );
    if (
      now.snapshot.state !== "OPEN" ||
      now.snapshot.headRefOid !== report.apiHead ||
      (report.baseHead !== undefined &&
        now.snapshot.baseRefOid !== report.baseHead)
    )
      return terminal(
        report,
        "HEAD_MOVED",
        `#${ctx.pr} changed (state ${now.snapshot.state}, head ${now.snapshot.headRefOid}) while the ${CHURN_CLASS} verdict was reached, so the park for round ${round} is withheld`,
      );
  }
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
      `${describeTrip(trip)}, but the ${CHURN_CLASS} park could not be recorded (park-churn exited ${park.code}); re-arm the drive once it is addressed`,
    );
  }
  const key = churnKey(round);
  report.parkedItemKeys = [...(report.parkedItemKeys ?? []), key].sort();
  report.actionableParkKeys = [
    ...(report.actionableParkKeys ?? []),
    key,
  ].sort();
  const parked = `${describeTrip(trip)}; the drive parked itself before round ${round}'s pass under ${CHURN_CLASS} (${key})`;
  if (report.mergeable === "CONFLICTING")
    return terminal(
      report,
      "PR_CONFLICTING",
      `PR #${ctx.pr} conflicts with its base (mergeable=${report.mergeable}${report.mergeStateStatus === "" ? "" : `, mergeStateStatus=${report.mergeStateStatus}`}) and ${parked}. Merge ${report.baseRefName === "" ? "the base branch" : report.baseRefName} into this one, push, and re-run; the park waits for its answer`,
    );
  return terminal(
    report,
    "HITL_PARKED",
    `${parked}: answer that decision, then re-arm`,
  );
}
