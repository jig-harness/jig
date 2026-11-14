/**
 * The tick's side of the shared records (`shared/records/shared.ts`): what
 * this host publishes for another host dispatching the same repository, and
 * what it reads of theirs. The local database stays the cache and the log:
 * this host plans its own launches from its launch records, and reads the
 * shared claims for every launch another host made.
 *
 * - **This host** is named in its claims by a digest of its dispatcher
 *   database's instance id (`hostOf`): a public comment names no machine, and
 *   a database created again is a new host, which no longer holds the old
 *   one's launches.
 * - **A drive's launch** is claimed beside its launch record, after the
 *   record holds its slot and before the runtime's `launch`
 *   (`launchClaimer`); a launch another host's current claim holds is not
 *   started, and a claim that loses its attempt gives the record back.
 * - **A launch's end** is written onto its claim by the host that made it:
 *   by the wrapper, after it records the stage's exit (`settleAtExit`) and
 *   any explicit rearm request's label removal has been acknowledged,
 *   so another host keeps the request reserved until then; and by that host's
 *   next tick with `--apply` for every claim whose launch record ended and
 *   still has none (`settleOwnClaims`), the backstop for a wrapper that died
 *   before its write and a forge that refused it. A claim whose record is
 *   gone from its host ends as died.
 * - **Another host's claims** are read for every pull request the plan
 *   classifies (`readSharedDrives`, and the follow-up markers), and placed
 *   beside this host's records (`foreignHold`): a current claim with no end
 *   holds the pull request, as held by that host; a refusal, a re-drive of
 *   the same change or an arm at the same head counts as if this host had
 *   launched it; and a driver another host started whose ledger is silent
 *   past the lease window is taken over by this host, under the ledger's own
 *   rule, never by a claim alone.
 */
import { recoveryReservationRefusal } from "./no-cause-stops.ts";
import { budgeted, sameFacts } from "./recovery-facts.ts";
import type { Outcome } from "../../shared/outcome.ts";
import type { ActionBook } from "./failures.ts";
import {
  endTarget,
  settleRetryableFollowups,
  writeOwedEnds,
  type OwedEnd,
} from "./settlement.ts";
import { settlesWithPerson } from "./redrive-settle.ts";
import { databaseInstance } from "../../shared/records/db.ts";
import { forgeShared } from "../../shared/records/shared-forge.ts";
import {
  type ClaimAnswer,
  type ClaimSays,
  changesOf,
  type LaunchDraft,
  type LaunchEnd,
  open,
  type ReadBackRule,
  type ReadClaim,
  readable,
  type SharedClaim,
  type SharedRecords,
  type SharedStage,
  unreadable,
  winners,
} from "../../shared/records/shared.ts";
import { digest, localWriter } from "../../shared/records/writer.ts";
import { stateRoot } from "../receipts.ts";
import { pendingRearm } from "./rearm-state.ts";
import { factsOf, settledConflict } from "./actions/drive-hold.ts";
import type { LaunchClaimer } from "./actions/launch.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import { retriedDeath, retryableFollowup } from "./session-startup.ts";
import { routineEnd, routineRerun } from "./routine-reruns.ts";
import { waitEnd } from "./followup-waits.ts";
import { resolveLogin } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { DRIVER_REFUSAL_EXITS } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  holds,
  isDrive,
  type LaunchRecord,
  type ReadRecord,
  settleEnds,
  writeRecord,
  cancelledBeforeExecution,
} from "./launches.ts";
import { stateDb } from "./state.ts";
import type { DrivenPr, FollowupMarker, MarkedPr } from "./types.ts";
import { currentIso, currentMs, parseMs } from "../../shared/time.ts";

/** This host as its claims name it: a digest of its dispatcher database's instance id. */
export function hostOf(root = stateRoot()): string {
  return digest(databaseInstance(stateDb(root)));
}

/** What one repository's tick reads and writes the shared records with. */
export interface SharedContext {
  records: SharedRecords;
  /** `owner/name`. */
  slug: string;
  /** This host, as its claims name it. */
  host: string;
  /** Whether this host owns the repository (the machine file's `owner`). */
  owner: boolean;
  /** The forge login the tick reads and writes as. */
  login: string | null;
  /** The read-back's rule; the shared records' own when absent. */
  rule?: ReadBackRule;
  /** State root for durable cancellation evidence; defaults to this dispatcher's. */
  root?: string;
}

/** Each drive's launch claims, by pull request, or why they did not read. */
export type DriveClaims = Map<number, Outcome<SharedClaim[], "unreadable">>;

/** Read the launch claims of each driven pull request. */
export function readSharedDrives(
  ctx: SharedContext,
  drives: readonly DrivenPr[],
): Promise<DriveClaims> {
  return ctx.records.listRepository(
    ctx.slug,
    drives.map((d) => d.number),
    "drive",
  );
}

const short = (host: string | null) => host ?? "(no host named)";

/** A claim, in words: whose, which launch and on what. */
function claimWords(c: ReadClaim): string {
  const s = c.says.value;
  return `host ${short(s.host)}'s launch claim (comment ${c.id}, attempt ${s.attempt}: a ${s.action} under its launch record ${String(s.record)})`;
}

/** Whether a claim's launch ended on `drive.ts`'s refusal of a second driver. */
function refusal(s: ClaimSays): number | null {
  const end = s.end;
  return end?.state === "ended" &&
    end.exit !== null &&
    DRIVER_REFUSAL_EXITS.has(end.exit)
    ? end.exit
    : null;
}

/**
 * Whether a claim's launch started the driver whose run the ledger shows:
 * that run began after the claim was made, and before the launch ended when
 * it has. A launch that died, or ended on a refusal, started no driver.
 */
function startedDriver(c: ReadClaim, pr: DrivenPr): boolean {
  const s = c.says.value;
  if (s.end?.state === "died" || refusal(s) !== null) return false;
  // A time that does not read is NaN, which no comparison holds for.
  const started = parseMs(String(pr.evidence.started));
  const until = s.end === null ? Infinity : parseMs(s.end.at);
  return parseMs(s.at) <= started && started <= until;
}

/** What another host's claims say about one driven pull request. */
export type ForeignHold =
  | { kind: "none" }
  | { kind: "unread"; why: string }
  | { kind: "held"; claim: ReadClaim; why: string }
  | { kind: "refused" | "redriven" | "armed"; claim: ReadClaim; why: string }
  | { kind: "takeover"; claim: ReadClaim };

/** Why another host's claims cannot be placed; `null` when they can. */
function unreadClaims(
  claims: Outcome<SharedClaim[], "unreadable">,
): string | null {
  if (!claims.ok)
    return `its launch claims could not be read: ${claims.failure.reason}`;
  const [bad] = unreadable(claims.value);
  if (bad === undefined) return null;
  const why = bad.says.ok ? "" : `: ${bad.says.failure.reason}`;
  return `a trusted launch claim (comment ${bad.id} by ${bad.login}) does not read${why}; a person settles it`;
}

/** A silent ledger beside another host's claims: a takeover of the driver one of them started, or what holds it off. */
function silentHold(
  pr: DrivenPr,
  theirs: ReadClaim[],
  latest: ReadClaim | null,
): ForeignHold {
  // A takeover already claimed past the silence, on these same facts, is in flight.
  if (
    latest !== null &&
    open(latest) &&
    sameFacts(latest.says.value.facts, factsOf(pr))
  )
    return {
      kind: "held",
      claim: latest,
      why: `${claimWords(latest)} acts on these same ledger facts and has not ended`,
    };
  // A drive settlement marked for notification as silent is a person's to
  // hear of, whatever a refused takeover once said on these facts. A driver
  // merely not shown gone (another host's, or unproven) keeps that refusal.
  const refused =
    pr.evidence.settled === true ? null : refusedOn(pr, latest, "taken over");
  if (refused !== null) return refused;
  const taken = takenOver(pr, theirs);
  if (taken !== null) return taken;
  const owner = theirs.findLast((c) => startedDriver(c, pr));
  return owner === undefined
    ? { kind: "none" }
    : { kind: "takeover", claim: owner };
}

/**
 * Another host's takeover of a driver no launch started, made on the ledger
 * facts as they are now and ended: the once-per-ledger takeover is spent, and
 * only a person settles the ledger until it moves. A takeover that never
 * executed spent nothing.
 */
function takenOver(pr: DrivenPr, theirs: ReadClaim[]): ForeignHold | null {
  // A launch that started the driver keeps it, whether or not the driver is
  // shown gone, and a completed takeover is spent whichever presence this
  // reader shows now: its probe may differ from the one that planned it.
  if (pr.evidence.settled === true) return null;
  if (theirs.some((c) => startedDriver(c, pr))) return null;
  const done = theirs.findLast((c) => {
    const s = c.says.value;
    return (
      s.action === "takeover" &&
      s.facts !== null &&
      sameFacts(s.facts, factsOf(pr)) &&
      s.end !== null &&
      !(s.end.state === "died" && s.end.executed === false)
    );
  });
  return done === undefined
    ? null
    : {
        kind: "refused",
        claim: done,
        why: `${claimWords(done)} already took it over on these ledger facts and has ended, leaving its ledger as it was: only a person settles it until its ledger moves`,
      };
}

/** Another host's latest launch, when it ended on `drive.ts`'s refusal on the ledger facts as they are now: the stage's answer, never fought. */
function refusedOn(
  pr: DrivenPr,
  latest: ReadClaim | null,
  again: string,
): ForeignHold | null {
  const refused = latest === null ? null : refusal(latest.says.value);
  if (
    latest === null ||
    refused === null ||
    !sameFacts(latest.says.value.facts, factsOf(pr))
  )
    return null;
  return {
    kind: "refused",
    claim: latest,
    why: `${claimWords(latest)} ended ${refused}, drive.ts's refusal, on these same ledger facts; it is not ${again} again until they change`,
  };
}

/**
 * Another host's claims beside one driven pull request, read after this
 * host's own launch records found nothing that holds it. This host's own
 * claims are read through its launch records, never here.
 */
export function foreignHold(
  pr: DrivenPr,
  claims: Outcome<SharedClaim[], "unreadable"> | undefined,
  host: string,
): ForeignHold {
  if (claims === undefined) return { kind: "none" };
  const unread = unreadClaims(claims);
  if (unread !== null || !claims.ok)
    return { kind: "unread", why: unread ?? "" };
  const won = winners(claims.value);
  const theirs = won.filter((c) => c.says.value.host !== host);
  const cur = won.at(-1) ?? null;
  const latest = cur !== null && cur.says.value.host !== host ? cur : null;
  if (pr.class === "silent") return silentHold(pr, theirs, latest);
  if (latest !== null && open(latest))
    return {
      kind: "held",
      claim: latest,
      why: `${claimWords(latest)} holds its launch: that host has not written its end`,
    };
  return (
    (pr.evidence.rearm === true ? null : refusedOn(pr, latest, "launched")) ??
    armedOrRedriven(pr, theirs) ?? { kind: "none" }
  );
}

/** Another host already armed this head, or re-drove this change. */
function armedOrRedriven(
  pr: DrivenPr,
  theirs: ReadClaim[],
): ForeignHold | null {
  if (pr.class === "unarmed") {
    const facts = factsOf(pr);
    const armed = theirs.findLast((c) => c.says.value.facts === facts);
    return armed === undefined
      ? null
      : {
          kind: "armed",
          claim: armed,
          why: `${claimWords(armed)} armed it at this head; it is not armed again until its head moves`,
        };
  }
  const change = pr.class === "stale" ? pr.stale?.change : undefined;
  if (change === undefined) return null;
  const done = theirs.findLast((c) => changesOf(c.says.value).includes(change));
  return done === undefined
    ? null
    : {
        kind: "redriven",
        claim: done,
        why: `stale (${pr.stale?.cause ?? pr.why}), and ${claimWords(done)} already re-drove it for this change; it is not launched again until its head or its mergeability changes`,
      };
}

/**
 * Each drive as the plan reads it once another host's claims are read
 * beside it: a ledger that stopped on a conflict, a stall or a spent
 * CI-repair budget, or parked on a pull request that conflicts, another host
 * having re-driven the change it shows now and that launch having ended,
 * is a person's to settle, as when this host re-drove it.
 */
export function settleSharedConflictStops(
  drives: readonly DrivenPr[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  return drives.map((pr) => {
    if (!settlesWithPerson(pr.stale)) return pr;
    const hold = foreignHold(pr, claims.get(pr.number), host);
    if (hold.kind !== "redriven" || open(hold.claim)) return pr;
    return settledConflict(
      pr,
      `${claimWords(hold.claim)} already re-drove it for this change and has ended`,
    );
  });
}

/**
 * Each silent drive another host already took over on the ledger facts it
 * shows now, that takeover having ended without moving the ledger on, as the
 * plan reads it: notified as silent and not taken over again, as when this
 * host's own record shows it. Left as the foreign hold the plan would
 * otherwise file quietly, no person would hear of the drive.
 */
export function settleSharedTakeovers(
  drives: readonly DrivenPr[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  return drives.map((pr) => {
    if (pr.class !== "silent") return pr;
    const read = claims.get(pr.number);
    if (read === undefined || !read.ok) return pr;
    const hold = foreignHold(pr, read, host);
    if (hold.kind !== "refused") return pr;
    const theirs = winners(read.value).filter(
      (c) => c.says.value.host !== host,
    );
    const taken = takenOver(pr, theirs);
    if (taken?.kind !== "refused" || taken.claim.id !== hold.claim.id)
      return pr;
    return {
      ...pr,
      why: `${pr.why}; ${taken.why}`,
      evidence: { ...pr.evidence, driverGone: false, settled: true },
    };
  });
}

/**
 * The pull requests a current claim with no end holds: a drive in progress.
 * This host's own open claim counts too: a launch that ended here before its
 * end was published still holds the pull request for every other host, so it
 * must for this one, or two hosts order the same pull requests differently.
 */
export function heldElsewhere(claims: DriveClaims): Set<number> {
  const held = new Set<number>();
  for (const [pr, read] of claims) {
    if (!read.ok) continue;
    const cur = winners(read.value).at(-1);
    if (cur !== undefined && open(cur)) held.add(pr);
  }
  return held;
}

/** The other hosts whose claims say they own the repository, from every claim this tick read. */
export function ownersSeen(
  claims: DriveClaims,
  merged: readonly MarkedPr[],
  host: string,
): string[] {
  const owners = [
    ...[...claims.values()].flatMap((read) =>
      read.ok
        ? readable(read.value).map((c) => ownerOf(c.says.value, host))
        : [],
    ),
    ...merged.flatMap((pr) =>
      "unreadable" in pr.markers
        ? []
        : pr.markers.map((m) => markerOwner(m, host)),
    ),
  ];
  return [...new Set(owners.filter((o): o is string => o !== null))].sort();
}

/** The host a claim names when it says that host owns the repository and is not `host`; `null` otherwise. */
function ownerOf(says: ClaimSays, host: string): string | null {
  return says.owner === true && says.host !== null && says.host !== host
    ? says.host
    : null;
}

/** The host a trusted tick marker names when it says that host owns the repository and is not `host`; `null` otherwise. */
function markerOwner(m: FollowupMarker, host: string): string | null {
  if (!m.trusted || m.run.kind !== "tick" || m.run.owner !== true) return null;
  const named = m.run.host ?? null;
  return named === null || named === host ? null : named;
}

/** The claimer a drive's launch posts its shared claim through. */
export function launchClaimer(ctx: SharedContext): LaunchClaimer {
  const targetOf = (r: LaunchRecord) => ({ repo: ctx.slug, pr: Number(r.pr) });
  return {
    async claim(record, replay = false) {
      const target = targetOf(record);
      const answer = await ctx.records.claim(
        target,
        launchDraft(ctx, record, replay),
        ctx.rule,
      );
      if (!answer.ok)
        return {
          refused: `the launch claim could not be made: ${answer.failure.reason}`,
          uncertain: true,
        };
      const a = answer.value;
      if (a.kind === "holds") return checkedReservation(ctx, record, a.id);
      const why = lostWhy(a);
      // Only another claim's standing is a loss; a read that does not settle is not.
      const uncertain = !["held", "earlier", "done"].includes(a.kind);
      if (!("id" in a)) return { refused: why, uncertain };
      const released = await withdrawUnstarted(ctx, record, a.id);
      return {
        refused: released.ok
          ? why
          : `${why}; its own claim (comment ${a.id}) could not be withdrawn (${released.failure.reason}), so this host's next tick ends it`,
        uncertain,
      };
    },
    async release(record, claim) {
      await withdrawUnstarted(ctx, record, claim);
    },
  };
}

/** The claim holds other hosts off while the latest history decides the recovery allowance. */
async function checkedReservation(
  ctx: SharedContext,
  record: LaunchRecord,
  own: number,
): Promise<{ claim: number } | { refused: string; uncertain?: boolean }> {
  const history = budgeted(record.facts)
    ? await ctx.records.list({ repo: ctx.slug, pr: Number(record.pr) }, "drive")
    : null;
  const why =
    history === null
      ? null
      : recoveryReservationRefusal(record, own, history, currentMs());
  if (why === null) return { claim: own };
  const released = await withdrawUnstarted(ctx, record, own);
  return {
    refused: released.ok
      ? why
      : `${why}; its claim could not be withdrawn: ${released.failure.reason}`,
    uncertain: !released.ok,
  };
}

/** A failed withdrawal leaves a durable cancellation for the next tick to publish. */
async function withdrawUnstarted(
  ctx: SharedContext,
  record: LaunchRecord,
  own: number,
) {
  const released = await ctx.records.release(
    { repo: ctx.slug, pr: Number(record.pr) },
    own,
  );
  if (!released.ok && record.attempts.every((a) => a.outcome === "failed")) {
    record.cancelledAt ??= currentIso();
    writeRecord(record, ctx.root ?? stateRoot());
  }
  return released;
}

/** The shared claim a drive's launch record makes. */
function launchDraft(
  ctx: SharedContext,
  record: LaunchRecord,
  replay: boolean,
): LaunchDraft {
  return {
    stage: "drive",
    pr: Number(record.pr),
    run: "tick",
    action: record.action === "takeover" ? "takeover" : "rearm",
    record: record.id,
    host: ctx.host,
    owner: ctx.owner,
    facts: record.facts,
    change: record.redrive?.change ?? null,
    earlier: record.redrive?.earlier ?? [],
    conflictStop: record.redrive?.conflictStop === true,
    ...(replay ? { replay } : {}),
    refusals: record.rearmLabel != null ? [] : [...DRIVER_REFUSAL_EXITS],
    writer: localWriter("forge", ctx.login),
  };
}

/** Why a claim the caller does not hold starts nothing. */
function lostWhy(a: Exclude<ClaimAnswer, { kind: "holds" }>): string {
  switch (a.kind) {
    case "held": {
      const who = a.by.says.ok
        ? claimWords(a.by as ReadClaim)
        : `launch claim comment ${a.by.id}`;
      return a.by.says.ok && a.by.says.value.end !== null
        ? `${who} ended on drive.ts's refusal on these same ledger facts; it is not launched again until they change`
        : `${who} holds its launch: that host has not written its end`;
    }
    case "earlier":
      return `an earlier launch claim (comment ${a.by.id}) won the attempt; this one stands down`;
    case "done":
      return "the launch claim reads as ended";
    default:
      return a.reason;
  }
}

/** How a launch record's launch ended, as its claim says it; `null` while it holds. */
function endOfRecord(
  r: ReadRecord | undefined,
  nowIso: string,
): LaunchEnd | null {
  if (r === undefined)
    return {
      state: "died",
      at: nowIso,
      reason: "its launch record is gone from the host that made it",
    };
  if (cancelledBeforeExecution(r))
    return {
      state: "died",
      at: r.record.cancelledAt ?? nowIso,
      reason: "its reservation was cancelled before execution",
      executed: false,
    };
  // Other hosts must retain the reservation until the request label is removed.
  if (holds(r.state) || pendingRearm(r.record, r.state)) return null;
  if (r.state.kind === "died")
    return { state: "died", at: nowIso, reason: r.state.reason };
  if (r.state.kind !== "ended") return null;
  const outcome = r.record.action === "followup" ? outcomeOf(r) : null;
  return {
    state: "ended",
    at: r.state.exit.at,
    exit: r.state.exit.code,
    outcome,
  };
}

/**
 * Write the end of each of this host's own claims that has none, once its
 * launch record ended or is gone; with `--apply` only, since it writes to the
 * forge. Returns why an end could not be written, for the report: a later
 * tick writes it. `book`, the failure ledger, backs off a repeating failure.
 */
export async function settleOwnClaims(
  ctx: SharedContext,
  claims: DriveClaims,
  merged: readonly MarkedPr[],
  records: readonly ReadRecord[],
  outcomes: ReadonlyMap<number, FollowupOutcome>,
  nowIso: string,
  startupScope?: ReadonlySet<number>,
  book?: ActionBook,
  rerunsHeld: string | null = null,
): Promise<string[]> {
  const byId = new Map(records.map((r) => [r.record.id, r]));
  const retryFailures = await settleRetryableFollowups(
    { ...ctx, rerunsHeld },
    records,
    nowIso,
    startupScope,
    settleRecordClaims,
  );
  const ends = [
    ...driveEnds(claims, ctx.host, byId, nowIso),
    ...merged.flatMap((pr) =>
      ownOpenMarkers(pr, ctx.host, byId, outcomes.get(pr.number)).flatMap(
        (m) =>
          // A retry's marker is released, never answered; so is one a routine run again follows.
          released(m.run.record, byId, outcomes.get(pr.number), records)
            ? []
            : owed(
                pr.number,
                "followup",
                m.id,
                markerEnd(m.run.record, outcomes.get(pr.number), byId, nowIso),
                m.run.host === undefined ? ctx.host : undefined,
              ),
      ),
    ),
  ];
  const owing = ends.filter(
    (o) =>
      !(
        o.stage === "followup" &&
        o.end.state === "ended" &&
        o.end.outcome === null
      ),
  );
  // A pull request whose claims, or any trusted marker, did not read owes what it owed: its rows stay.
  const unread = new Set<string>([
    ...[...claims]
      .filter(([, read]) => unreadClaims(read) !== null)
      .map(([pr]) => `PR #${pr}`),
    ...merged
      .filter(
        (pr) =>
          "unreadable" in pr.markers ||
          pr.markers.some((m) => m.trusted && m.run.kind === "unreadable"),
      )
      .map((pr) => `PR #${pr.number}`),
  ]);
  const unobserved = (target: string) => unread.has(target);
  book?.wanted(
    "claim-end",
    owing.filter((o) => o.stage === "drive").map((o) => endTarget(o).key),
    unobserved,
  );
  book?.wanted(
    "marker-answer",
    owing.filter((o) => o.stage !== "drive").map((o) => endTarget(o).key),
    unobserved,
  );
  const { failures, written } = await writeOwedEnds(ctx, owing, book);
  settleEnds(
    settledRecords(claims, ctx.host, records, written, nowIso),
    nowIso,
    ctx.root,
  );
  return [...retryFailures, ...failures];
}

/** How long each forge call of the wrapper's settle may take: the wrapper's terminal stays open until they are done. */
const AT_EXIT_CALL_SEC = 10;

/** The stage whose claim a launch record makes: a drive's launch claim or a follow-up's marker; a pickup's is the tracker's. */
function stageOf(record: LaunchRecord): SharedStage | null {
  if (isDrive(record)) return "drive";
  return record.action === "followup" ? "followup" : null;
}

/** The end a record's own claims owe once it ended, with their stage and pull request; `null` when they owe none. */
function owedAtExit(
  r: ReadRecord,
  nowIso: string,
): { stage: SharedStage; pr: number; end: LaunchEnd } | null {
  const stage = stageOf(r.record);
  const end = endOfRecord(r, nowIso);
  if (stage === null || r.record.pr === null || end === null) return null;
  return { stage, pr: r.record.pr, end };
}

/**
 * Write the end of the claims this host made for one launch record that
 * ended: each of this host's claims on the record's pull request that names
 * the record and has no end yet. Returns why an end could not be written,
 * which this host's next tick writes (`settleOwnClaims`).
 */
async function settleRecordClaims(
  ctx: Pick<SharedContext, "records" | "host">,
  r: ReadRecord,
  nowIso: string,
  root = stateRoot(),
): Promise<string[]> {
  const owed = owedAtExit(r, nowIso);
  if (owed === null) return [];
  const target = { repo: r.record.repo, pr: owed.pr };
  const read = await ctx.records.list(target, owed.stage);
  if (!read.ok)
    return [
      `PR #${owed.pr}: the claims could not be read: ${read.failure.reason}`,
    ];
  // A trusted malformed companion may hide another obligation of this launch.
  // Report it independently of the readable claims whose ends can be written.
  const unread = unreadClaims(read);
  const failures: string[] =
    unread === null ? [] : [`PR #${owed.pr}: ${unread}`];
  const matches = ownRecordClaims(
    read.value,
    r.record.id,
    ctx.host,
    owed.stage,
  );
  if (retryableFollowup(r)) {
    // A death's marker may already carry an answer an earlier settle wrote; it is released all the same.
    const ids = matches
      .filter((c) => open(c) || retriedDeath(r))
      .map((c) => c.id);
    // The listing can lag a post or omit a marker already deleted by a tick.
    // Delete the recorded id as well: only a successful deletion or an explicit
    // not-found response confirms that this launch's marker no longer exists.
    if (
      !matches.some((c) => c.id === r.record.marker) &&
      r.record.marker !== null
    ) {
      ids.push(r.record.marker);
    }
    const released = await releaseStartupClaims(
      ctx,
      target,
      ids,
      retriedDeath(r) ? "died" : "unstarted",
    );
    if (
      r.record.marker !== null &&
      failures.length === 0 &&
      released.length === 0
    )
      settleEnds([r.record.id], nowIso, root);
    return [...failures, ...released];
  }
  if (matches.length === 0)
    return [
      ...failures,
      `PR #${owed.pr}: no readable claim for launch record ${r.record.id} was observed`,
    ];
  return [...failures, ...(await writeRecordEnds(ctx, target, owed, matches))];
}

/** Publish each readable still-open claim's end, keeping independent write failures. */
async function writeRecordEnds(
  ctx: Pick<SharedContext, "records" | "host">,
  target: { repo: string; pr: number },
  owed: { stage: SharedStage; pr: number; end: LaunchEnd },
  matches: ReadClaim[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const c of matches) {
    if (!open(c)) continue;
    const done = await ctx.records.end(
      target,
      owed.stage,
      c.id,
      owed.end,
      c.says.value.host === null ? ctx.host : undefined,
    );
    if (!done.ok)
      failures.push(
        `PR #${owed.pr}: the end of claim comment ${c.id} could not be written: ${done.failure.reason}`,
      );
  }
  return failures;
}

/** Match readable claims to this host's record, including legacy hostless follow-ups. */
function ownRecordClaims(
  claims: SharedClaim[],
  record: string,
  host: string,
  stage: SharedStage,
): ReadClaim[] {
  return readable(claims).filter(
    (c) =>
      c.says.value.record === record &&
      (c.says.value.host === host ||
        (stage === "followup" && c.says.value.host === null)),
  );
}

/** Whether the marker naming `record` is released rather than answered: a retry's, or one a routine run again or a rate limit's reset follows. */
function released(
  record: string,
  byId: ReadonlyMap<string, ReadRecord>,
  written: FollowupOutcome | undefined,
  records: readonly ReadRecord[],
): boolean {
  const r = byId.get(record);
  if (retryable(r) || (r !== undefined && (routineEnd(r) || waitEnd(r))))
    return true;
  return routineRerun(written, records)?.record === record;
}

/** Whether a record's end is a follow-up's retry, whose marker is released rather than answered. */
function retryable(r: ReadRecord | undefined): boolean {
  return r !== undefined && retryableFollowup(r);
}

/** A retried follow-up releases only its own claims. */
async function releaseStartupClaims(
  ctx: Pick<SharedContext, "records">,
  target: { repo: string; pr: number },
  ids: number[],
  what: "unstarted" | "died",
): Promise<string[]> {
  const failures: string[] = [];
  for (const id of ids) {
    const released = await ctx.records.release(target, id);
    if (!released.ok && released.failure.code !== "not-found")
      failures.push(
        `PR #${target.pr}: the ${what} follow-up's marker ${id} could not be released: ${released.failure.reason}`,
      );
  }
  return failures;
}

/**
 * The wrapper's settle, right after it records the stage's exit: the end of
 * its own launch's claims, written at once so another host reads it when the
 * launch ends. Every forge call, the read of the login among them, goes
 * through `ghCall` under `AT_EXIT_CALL_SEC`. Best effort: it returns why an
 * end was not written, and the tick's settle writes it. Retryable startup
 * markers, and those of a follow-up that owes a routine run again, are
 * released only by the tick, which reads current dispatch scope; so are
 * those of a follow-up that waits out a rate limit (`followup-waits.ts`).
 */
export async function settleAtExit(
  r: ReadRecord,
  root = stateRoot(),
): Promise<string[]> {
  // A retry's marker deletion needs the tick's current scope and dispute checks.
  if (retryableFollowup(r) || routineEnd(r) || waitEnd(r, root)) return [];
  const nowIso = currentIso();
  if (owedAtExit(r, nowIso) === null) return [];
  const login = await resolveLogin(AT_EXIT_CALL_SEC);
  const records = forgeShared({ login, timeoutSec: AT_EXIT_CALL_SEC });
  return settleRecordClaims({ records, host: hostOf(root) }, r, nowIso, root);
}

/**
 * The finished drive records whose end is positively confirmed: this host's
 * own claims for the record all read with their end, or their end was written
 * this tick. A listing that omits the claim (it lags) or one the claim is
 * unreadable in confirms nothing, so that record's pull request is read again.
 * A trusted claim that does not read could conceal another obligation, so any
 * such claim on the pull request keeps every record on it unsettled. A record
 * with no claim of its own never settles: nothing here can tell a launch that
 * predates shared claims from one whose claim a listing omits, and settling the
 * second would skip its pull request for good.
 */
export function settledRecords(
  claims: DriveClaims,
  host: string,
  records: readonly ReadRecord[],
  written: ReadonlySet<number>,
  nowIso: string,
): string[] {
  return records
    .filter((r) => {
      if (r.record.action === "followup" || r.record.pr === null) return false;
      if (endOfRecord(r, nowIso) === null || r.state.kind === "unknown")
        return false;
      const read = claims.get(Number(r.record.pr));
      if (read === undefined || !read.ok) return false;
      if (unreadable(read.value).length > 0) return false;
      const own = readable(read.value).filter(
        (c) =>
          c.says.value.host === host && c.says.value.record === r.record.id,
      );
      if (own.length === 0) return false;
      return own.every((c) => written.has(c.id) || !open(c));
    })
    .map((r) => r.record.id);
}

/** One end this host owes: its own claim's, on a pull request. */
const owed = (
  pr: number,
  stage: OwedEnd["stage"],
  id: number,
  end: LaunchEnd | null,
  host?: string,
): OwedEnd[] =>
  end === null ? [] : [{ pr, stage, id, end, ...(host ? { host } : {}) }];

/** This host's own claims that read and have no end yet. */
function ownOpen(
  read: Outcome<SharedClaim[], "unreadable">,
  host: string,
): ReadClaim[] {
  if (!read.ok) return [];
  return readable(read.value).filter(
    (c) => c.says.value.host === host && open(c),
  );
}

/** The ends this host's own drive claims owe: each open one whose launch record ended or is gone. */
function driveEnds(
  claims: DriveClaims,
  host: string,
  byId: ReadonlyMap<string, ReadRecord>,
  nowIso: string,
): OwedEnd[] {
  return [...claims].flatMap(([pr, read]) =>
    ownOpen(read, host).flatMap((c) =>
      owed(
        pr,
        "drive",
        c.id,
        endOfRecord(byId.get(String(c.says.value.record)), nowIso),
      ),
    ),
  );
}

type TickMarker = FollowupMarker & {
  run: Extract<FollowupMarker["run"], { kind: "tick" }>;
};

/**
 * This host's own markers on a merged pull request that carry no answer yet:
 * those naming this host, and those posted before markers named a host whose
 * launch record is on this machine or whose outcome record, which outlives the
 * launch record, names it.
 */
function ownOpenMarkers(
  pr: MarkedPr,
  host: string,
  byId: ReadonlyMap<string, ReadRecord>,
  written: FollowupOutcome | undefined,
): TickMarker[] {
  if ("unreadable" in pr.markers) return [];
  return pr.markers.filter(
    (m): m is TickMarker =>
      m.trusted &&
      m.run.kind === "tick" &&
      (m.run.host === host ||
        (m.run.host === undefined &&
          (byId.has(m.run.record) || written?.record === m.run.record))) &&
      m.run.outcome === undefined,
  );
}

/** A follow-up's end: its outcome record's when it names the marker's launch record, else its launch record's. */
function markerEnd(
  record: string,
  written: FollowupOutcome | undefined,
  byId: ReadonlyMap<string, ReadRecord>,
  nowIso: string,
): LaunchEnd | null {
  if (written?.record === record)
    return {
      state: "ended",
      at: written.at,
      exit: null,
      outcome: written.outcome,
    };
  return endOfRecord(byId.get(record), nowIso);
}
