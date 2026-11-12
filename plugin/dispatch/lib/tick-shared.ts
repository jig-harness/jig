/**
 * One repository's shared records in a tick (`shared-launches.ts`): opened as
 * the login the forge names, read for every pull request the plan
 * classifies, written for this host's own launches, and reported on the
 * receipt with every read and write and the forge budget left as the tick
 * started, as the board's read reports its cost, so what sharing costs is
 * measured. The observe phase reads the claims from the tick's comment
 * listings (`tick-comments.ts`); the stages' reads before a launch go to the
 * forge, and every write drops its pull request's listing.
 */
import {
  current,
  open as openClaim,
  type SharedClaim,
  type SharedOp,
  type SharedRecords,
  unreadable,
} from "../../shared/records/shared.ts";
import { forgeShared } from "../../shared/records/shared-forge.ts";
import { settleNoCauseStops } from "./no-cause-stops.ts";
import { settleFailedRearms, withRearmHeads } from "./failed-rearms.ts";
import { releaseRoutineMarkers } from "./routine-reruns.ts";
import {
  driveHold,
  settleConflictStops,
  settleSilentTakeovers,
} from "./actions/drive-hold.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import { type ReadRecord, settledEnds } from "./launches.ts";
import {
  keptClaims,
  type MergeRead,
  readMergeReads,
  writeKeptClaims,
} from "./merge-reads.ts";
import {
  type DriveClaims,
  foreignHold,
  hostOf,
  ownersSeen,
  readSharedDrives,
  type SharedContext,
  settleOwnClaims,
  settleSharedConflictStops,
  settleSharedTakeovers,
} from "./shared-launches.ts";
import {
  forgettingWrites,
  listingReader,
  type TickComments,
} from "./tick-comments.ts";
import type { ForgeRead } from "./tick-forge.ts";
import type { ActionBook } from "./failures.ts";
import type { DrivenPr, MarkedPr, RepoReport, SharedReport } from "./types.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";

/** A repository's shared records for one tick. */
export interface TickShared {
  /** The records as the observe phase reads them, from the tick's comment listings; the first call opens them. */
  records(login: string | null): SharedRecords;
  /** The context the stages read and write through, once the login is known: its reads go to the forge, its writes drop their pull request's listing. */
  context(login: string | null): SharedContext;
  ops: SharedOp[];
}

/** Open a repository's shared records for one tick, as this host, owning it or not, reading through the tick's comment listings. */
export function openShared(
  slug: string,
  owner: boolean,
  comments: TickComments,
): TickShared {
  const ops: SharedOp[] = [];
  const note = (op: SharedOp) => ops.push(op);
  let ctx: SharedContext | null = null;
  let reader: SharedRecords | null = null;
  const context = (login: string | null): SharedContext => {
    ctx ??= {
      records: forgettingWrites(forgeShared({ login, record: note }), comments),
      slug,
      host: hostOf(),
      owner,
      login,
    };
    return ctx;
  };
  const records = (login: string | null): SharedRecords => {
    const opened = context(login);
    reader ??= listingReader(opened.records, comments, opened.login, note);
    return reader;
  };
  return { records, context, ops };
}

/**
 * A drive that ended and whose pull request has since merged or closed is no
 * longer in the open population, yet its claim still owes its end: read the
 * claims of each pull request this host's own launch records name that the
 * open drives do not cover. A record is the obligation until `settleOwnClaims`
 * notes that every end it owed is written (or it is pruned), so a settled
 * record's pull request is never read again and an unwritten end is read
 * until it is written.
 *
 * On a merge, with `nowMs` given, the claims a tick kept are read in place of
 * the forge's while they stand (`keptEnded`); the claims read otherwise are
 * kept for the next tick (`merge-reads.ts`). Writing an end lists the claims
 * from the forge first, and the write drops what was kept.
 */
async function addEndedLaunches(
  ctx: SharedContext,
  forge: ForgeRead,
  records: readonly ReadRecord[],
  claims: DriveClaims,
  nowMs?: number,
): Promise<void> {
  const extra = endedLaunches(ctx.slug, forge, records);
  if (extra.size === 0) return;
  const merged = new Map(forge.merged.map((p) => [p.number, p]));
  const toRead =
    nowMs === undefined
      ? [...extra.keys()]
      : fromKept(ctx, extra, merged, claims, nowMs);
  if (toRead.length === 0) return;
  const read = await ctx.records.listRepository(ctx.slug, toRead, "drive");
  for (const [pr, listing] of read) {
    claims.set(pr, listing);
    const updatedAt = merged.get(pr)?.updatedAt;
    if (nowMs !== undefined && listing.ok && updatedAt !== undefined)
      writeKeptClaims(ctx.slug, pr, updatedAt, listing.value, nowMs, ctx.login);
  }
}

/** This host's launch records whose claims may still owe an end, by the pull request outside the open drives they name. */
function endedLaunches(
  slug: string,
  forge: ForgeRead,
  records: readonly ReadRecord[],
): Map<number, ReadRecord[]> {
  const open = new Set(forge.drives.map((d) => d.number));
  const extra = new Map<number, ReadRecord[]>();
  const settled = settledEnds();
  const inScope = (pr: number) =>
    !forge.scoped || (forge.inScope.has(pr) && !forge.disputed.has(pr));
  for (const r of records) {
    if (r.record.repo !== slug || r.record.action === "followup") continue;
    if (settled.has(r.record.id)) continue;
    const pr = Number(r.record.pr);
    // Under `only_labeled` nothing is written on a pull request out of scope, so its claims are not read to be ended.
    if (!Number.isInteger(pr) || open.has(pr) || !inScope(pr)) continue;
    extra.set(pr, [...(extra.get(pr) ?? []), r]);
  }
  return extra;
}

/** Put the kept claims that stand into `claims`; the pull requests left to read. */
function fromKept(
  ctx: SharedContext,
  extra: ReadonlyMap<number, readonly ReadRecord[]>,
  merged: ReadonlyMap<number, MarkedPr>,
  claims: DriveClaims,
  nowMs: number,
): number[] {
  const kept = readMergeReads(ctx.slug);
  const toRead: number[] = [];
  for (const [pr, own] of extra) {
    const reuse = keptEnded(
      kept.get(pr),
      merged.get(pr),
      own,
      ctx.host,
      nowMs,
      ctx.login,
    );
    if (reuse === null) toRead.push(pr);
    else claims.set(pr, { ok: true, value: reuse });
  }
  return toRead;
}

/**
 * The claims kept of a merge whose ended launches owe their ends, when they
 * stand for this tick: kept at the merge's `updatedAt` now and inside the
 * cadence (`keptClaims`), every launch record of this host's on it ended,
 * and, as they were last read, no trusted claim that does not read and no
 * current claim of another host's with no end. Anything else is read from
 * the forge. These claims admit no launch: a merged pull request is never
 * re-armed, and a launch's own claim is read from the forge.
 */
function keptEnded(
  kept: MergeRead | undefined,
  pr: MarkedPr | undefined,
  own: readonly ReadRecord[],
  host: string,
  nowMs: number,
  login: string | null,
): SharedClaim[] | null {
  if (pr === undefined) return null;
  if (!own.every((r) => r.state.kind === "ended" || r.state.kind === "died"))
    return null;
  const claims = keptClaims(kept, pr, nowMs, login);
  if (claims === null || unreadable(claims).length > 0) return null;
  const now = current(claims);
  return now !== null && openClaim(now) && now.says.value.host !== host
    ? null
    : claims;
}

/**
 * Read the launch claims of every drive the forge gave, and the heads of
 * each whose latest re-arm failed (`failed-rearms.ts`), and settle each
 * drive's stop on a conflict by this host's records and then by another
 * host's claims. The claims are read through `reader`, the tick's comment
 * listings where the observe phase passes them, and, with the tick's clock
 * `nowMs`, an ended launch's merge from the claims a tick kept of it.
 */
export async function readDriveClaims(
  ctx: SharedContext,
  forge: ForgeRead,
  records: readonly ReadRecord[],
  reader: SharedRecords = ctx.records,
  nowMs?: number,
): Promise<DriveClaims> {
  const reading = { ...ctx, records: reader };
  const claims: DriveClaims = forge.ok
    ? await readSharedDrives(reading, forge.drives)
    : new Map();
  if (forge.ok) await addEndedLaunches(reading, forge, records, claims, nowMs);
  const weighed = await withRearmHeads(
    ctx.slug,
    forge.drives,
    forge.open,
    records,
  );
  forge.drives = settleDrives(ctx, weighed, records, claims);
  return claims;
}

/**
 * Each drive as the plan reads it once this host's records and every host's
 * claims are read beside it: a re-drive already made for the change it shows
 * now is a person's (by this host's records, then by another host's claims),
 * so is a re-arm that failed at the heads and ledger facts it shows now, a
 * silent driver already taken over on its facts is notified, and what is
 * left is bounded by the pull request's recovery budget.
 */
export function settleDrives(
  ctx: Pick<SharedContext, "slug" | "host">,
  drives: readonly DrivenPr[],
  records: readonly ReadRecord[],
  claims: DriveClaims,
): DrivenPr[] {
  return settleOwnDrives(
    drives,
    records.filter((r) => r.record.repo === ctx.slug),
    claims,
    ctx.host,
  );
}

/** `settleDrives` over launch records already scoped to the drives' repository. */
export function settleOwnDrives(
  drives: readonly DrivenPr[],
  own: ReadRecord[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  const placed = markUnlaunched(
    settleUnownedTakeovers(drives, own, claims, host),
    own,
    claims,
    host,
  );
  return settleNoCauseStops(
    settleFailedRearms(
      settleSharedConflictStops(settleConflictStops(placed, own), claims, host),
      own,
    ),
    own,
    claims,
    currentMs(),
  );
}

/** Settle only after both sources agree no launch owns or holds the driver. */
function settleUnownedTakeovers(
  drives: readonly DrivenPr[],
  own: ReadRecord[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  const candidates = drives.filter((pr) => {
    if (pr.class !== "silent") return false;
    // Ignore refusals while looking for the owner behind them. A refusal
    // remains final when either source still attributes the running driver.
    const probe = { ...pr, evidence: { ...pr.evidence, settled: true } };
    return (
      driveHold(probe, own).kind === "none" &&
      foreignHold(probe, claims.get(pr.number), host).kind === "none"
    );
  });
  const settled = new Map(
    settleSilentTakeovers(
      settleSharedTakeovers(candidates, claims, host),
      own,
    ).map((pr) => [pr.number, pr]),
  );
  return drives.map((pr) => settled.get(pr.number) ?? pr);
}

/**
 * Each silent drive whose driver this host shows gone, marked `unlaunched`
 * when neither this host's launch records nor another host's claims place it
 * (start its driver, hold it, or answer it with a refusal): only that
 * takeover is a re-drive the recovery budget counts. A takeover of a driver
 * a launch started is planned from that launch's record or claim, outside
 * the budget.
 */
function markUnlaunched(
  drives: readonly DrivenPr[],
  own: ReadRecord[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  return drives.map((pr) => {
    if (pr.class !== "silent" || pr.evidence.driverGone !== true) return pr;
    // This host's own refused takeover places no driver by itself: it is the
    // takeover `settleSilentTakeovers` settles. It hides the drive from that
    // only when no older record started the driver, which settlement (reading
    // the drive as settled) would take over again.
    const hold = driveHold(pr, own);
    const unplaced =
      hold.kind === "none" ||
      (hold.kind === "refused" &&
        hold.record.record.action === "takeover" &&
        driveHold({ ...pr, evidence: { ...pr.evidence, settled: true } }, own)
          .kind === "none");
    return unplaced &&
      foreignHold(pr, claims.get(pr.number), host).kind === "none"
      ? { ...pr, evidence: { ...pr.evidence, unlaunched: true } }
      : pr;
  });
}

/** With `--apply`: write the end of this host's own claims whose launch records ended, release the markers of follow-ups that owe a routine run again, and report what could not be done. */
export async function endOwnClaims(
  ctx: SharedContext,
  report: RepoReport,
  inputs: {
    claims: DriveClaims;
    forge: ForgeRead;
    records: readonly ReadRecord[];
    outcomes: ReadonlyMap<number, FollowupOutcome>;
    nowMs: number;
    /** The failure ledger: an end that keeps failing backs off. */
    book?: ActionBook | null;
  },
): Promise<void> {
  const scope = inputs.forge.scoped
    ? new Set(
        [...inputs.forge.inScope].filter(
          (pr) => !inputs.forge.disputed.has(pr),
        ),
      )
    : undefined;
  const own = inputs.records.filter((r) => r.record.repo === ctx.slug);
  const failures = [
    ...(await settleOwnClaims(
      ctx,
      inputs.claims,
      inputs.forge.merged,
      own,
      inputs.outcomes,
      isoFromMs(inputs.nowMs),
      scope,
      inputs.forge.ok ? (inputs.book ?? undefined) : undefined,
    )),
    ...(await releaseRoutineMarkers(
      ctx,
      inputs.forge.merged,
      own,
      inputs.outcomes,
      scope,
    )),
  ];
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

/** The receipt's part: which host owns the repository, and each read and write; the forge budget left is filled once the tick closes (`tick-reads.ts`). */
export function sharedReport(
  shared: TickShared,
  ctx: SharedContext,
  claims: DriveClaims,
  forge: ForgeRead,
): SharedReport {
  const ops = shared.ops;
  return {
    medium: ctx.records.medium,
    host: ctx.host,
    owner: ctx.owner,
    owners: ownersSeen(claims, forge.merged, ctx.host),
    ops,
    reads: ops.filter((o) => !WRITES.has(o.op) && o.op !== "budget").length,
    writes: ops.filter((o) => WRITES.has(o.op)).length,
    budget: null,
  };
}
