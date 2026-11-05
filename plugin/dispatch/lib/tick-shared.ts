/**
 * One repository's shared records in a tick (`shared-launches.ts`): opened as
 * the login the forge names, read for every pull request the plan
 * classifies, written for this host's own launches, and reported on the
 * receipt with every read and write and the forge budget left after them,
 * as the board's read reports its cost, so what sharing costs is measured.
 */
import type { SharedRecords, SharedOp } from "../../shared/records/shared.ts";
import { forgeShared } from "../../shared/records/shared-forge.ts";
import { settleConflictStops } from "./actions/drive-hold.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import type { ReadRecord } from "./launches.ts";
import {
  type DriveClaims,
  hostOf,
  ownersSeen,
  readSharedDrives,
  type SharedContext,
  settleOwnClaims,
  settleSharedConflictStops,
} from "./shared-launches.ts";
import type { ForgeRead } from "./tick-forge.ts";
import type { RepoReport, SharedReport } from "./types.ts";

/** A repository's shared records for one tick. */
export interface TickShared {
  /** The records as `login`; the first call opens them, later calls return the same. */
  records(login: string | null): SharedRecords;
  /** The context the stages read and write through, once the login is known. */
  context(login: string | null): SharedContext;
  ops: SharedOp[];
}

/** Open a repository's shared records for one tick, as this host, owning it or not. */
export function openShared(slug: string, owner: boolean): TickShared {
  const ops: SharedOp[] = [];
  let ctx: SharedContext | null = null;
  const context = (login: string | null): SharedContext => {
    ctx ??= {
      records: forgeShared({ login, record: (op) => ops.push(op) }),
      slug,
      host: hostOf(),
      owner,
      login,
    };
    return ctx;
  };
  return { records: (login) => context(login).records, context, ops };
}

/**
 * A drive that ended and whose pull request has since merged or closed is no
 * longer in the open population, yet its claim still owes its end: read the
 * claims of each pull request this host's own launch records name that the
 * open drives do not cover.
 */
async function addEndedLaunches(
  ctx: SharedContext,
  forge: ForgeRead,
  records: readonly ReadRecord[],
  claims: DriveClaims,
): Promise<void> {
  const open = new Set(forge.drives.map((d) => d.number));
  const extra = new Set<number>();
  for (const r of records) {
    if (r.record.repo !== ctx.slug || r.record.action === "followup") continue;
    const pr = Number(r.record.pr);
    if (Number.isInteger(pr) && !open.has(pr)) extra.add(pr);
  }
  if (extra.size === 0) return;
  const read = await ctx.records.listRepository(ctx.slug, [...extra], "drive");
  for (const [pr, listing] of read) claims.set(pr, listing);
}

/**
 * Read the launch claims of every drive the forge gave, and settle each
 * drive's stop on a conflict by this host's records and then by another
 * host's claims.
 */
export async function readDriveClaims(
  ctx: SharedContext,
  forge: ForgeRead,
  records: readonly ReadRecord[],
): Promise<DriveClaims> {
  const claims: DriveClaims = forge.ok
    ? await readSharedDrives(ctx, forge.drives)
    : new Map();
  if (forge.ok) await addEndedLaunches(ctx, forge, records, claims);
  forge.drives = settleSharedConflictStops(
    settleConflictStops(
      forge.drives,
      records.filter((r) => r.record.repo === ctx.slug),
    ),
    claims,
    ctx.host,
  );
  return claims;
}

/** With `--apply`: write the end of this host's own claims whose launch records ended, and report what could not be written. */
export async function endOwnClaims(
  ctx: SharedContext,
  report: RepoReport,
  inputs: {
    claims: DriveClaims;
    forge: ForgeRead;
    records: readonly ReadRecord[];
    outcomes: ReadonlyMap<number, FollowupOutcome>;
    nowMs: number;
  },
): Promise<void> {
  const failures = await settleOwnClaims(
    ctx,
    inputs.claims,
    inputs.forge.merged,
    inputs.records.filter((r) => r.record.repo === ctx.slug),
    inputs.outcomes,
    new Date(inputs.nowMs).toISOString(),
  );
  for (const reason of failures)
    report.unplaced.push({
      target: "the shared records",
      record: "forge",
      reason,
    });
}

const WRITES: ReadonlySet<SharedOp["op"]> = new Set([
  "claim",
  "end",
  "release",
]);

/** The receipt's part: which host owns the repository, each read and write, and the forge budget left. */
export async function sharedReport(
  shared: TickShared,
  ctx: SharedContext,
  claims: DriveClaims,
  forge: ForgeRead,
): Promise<SharedReport> {
  const budget = forge.ok ? await ctx.records.budget() : null;
  const ops = shared.ops;
  return {
    medium: ctx.records.medium,
    host: ctx.host,
    owner: ctx.owner,
    owners: ownersSeen(claims, forge.merged, ctx.host),
    ops,
    reads: ops.filter((o) => !WRITES.has(o.op) && o.op !== "budget").length,
    writes: ops.filter((o) => WRITES.has(o.op)).length,
    budget:
      budget === null
        ? null
        : budget.ok
          ? budget.value
          : { unreadable: budget.failure.reason },
  };
}
