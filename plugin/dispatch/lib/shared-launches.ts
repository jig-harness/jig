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
 * - **A launch's end** is written onto its claim by the host that made it,
 *   at that host's next tick with `--apply`, once the wrapper's exit or the
 *   session's result ends the launch record (`settleOwnClaims`); a claim
 *   whose record is gone from its host ends as died.
 * - **Another host's claims** are read for every pull request the plan
 *   classifies (`readSharedDrives`, and the follow-up markers), and placed
 *   beside this host's records (`foreignHold`): a current claim with no end
 *   holds the pull request, as held by that host; a refusal, a re-drive of
 *   the same change or an arm at the same head counts as if this host had
 *   launched it; and a driver another host started whose ledger is silent
 *   past the lease window is taken over by this host, under the ledger's own
 *   rule, never by a claim alone.
 */
import type { Outcome } from "../../shared/outcome.ts";
import { databaseInstance } from "../../shared/records/db.ts";
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
  unreadable,
  winners,
} from "../../shared/records/shared.ts";
import { digest, localWriter } from "../../shared/records/writer.ts";
import { stateRoot } from "../receipts.ts";
import { factsOf } from "./actions/drive-hold.ts";
import type { LaunchClaimer } from "./actions/launch.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import {
  DRIVER_REFUSALS,
  holds,
  type LaunchRecord,
  type ReadRecord,
  settleEnds,
} from "./launches.ts";
import { stateDb } from "./state.ts";
import type { DrivenPr, FollowupMarker, MarkedPr } from "./types.ts";

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
    DRIVER_REFUSALS.has(end.exit)
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
  const started = Date.parse(String(pr.evidence.started));
  const until = s.end === null ? Infinity : Date.parse(s.end.at);
  return Date.parse(s.at) <= started && started <= until;
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
    latest.says.value.facts === factsOf(pr)
  )
    return {
      kind: "held",
      claim: latest,
      why: `${claimWords(latest)} acts on these same ledger facts and has not ended`,
    };
  const refused = refusedOn(pr, latest, "taken over");
  if (refused !== null) return refused;
  const owner = theirs.findLast((c) => startedDriver(c, pr));
  return owner === undefined
    ? { kind: "none" }
    : { kind: "takeover", claim: owner };
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
    latest.says.value.facts !== factsOf(pr)
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
    refusedOn(pr, latest, "launched") ??
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
 * beside it: a ledger that stopped on a conflict, another host having
 * re-driven the change it shows now and that launch having ended, is a
 * person's to settle, as when this host re-drove it.
 */
export function settleSharedConflictStops(
  drives: readonly DrivenPr[],
  claims: DriveClaims,
  host: string,
): DrivenPr[] {
  return drives.map((pr) => {
    if (pr.stale?.conflictStop !== true) return pr;
    const hold = foreignHold(pr, claims.get(pr.number), host);
    if (hold.kind !== "redriven" || open(hold.claim)) return pr;
    const { stale: _settled, ...rest } = pr;
    return {
      ...rest,
      class: "needs-person",
      why: `stopped on a conflict with its base, and ${claimWords(hold.claim)} already re-drove it for this change and has ended: only a person settles it until its head or its base moves (see the drive's handoff)`,
    };
  });
}

/** The pull requests another host's current claim with no end holds: a drive in progress there. */
export function heldElsewhere(claims: DriveClaims, host: string): Set<number> {
  const held = new Set<number>();
  for (const [pr, read] of claims) {
    if (!read.ok) continue;
    const cur = winners(read.value).at(-1);
    if (cur !== undefined && cur.says.value.host !== host && open(cur))
      held.add(pr);
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
      if (a.kind === "holds") return { claim: a.id };
      const why = lostWhy(a);
      // Only another claim's standing is a loss; a read that does not settle is not.
      const uncertain = !["held", "earlier", "done"].includes(a.kind);
      if (!("id" in a)) return { refused: why, uncertain };
      const released = await ctx.records.release(target, a.id);
      return {
        refused: released.ok
          ? why
          : `${why}; its own claim (comment ${a.id}) could not be withdrawn (${released.failure.reason}), so this host's next tick ends it`,
        uncertain,
      };
    },
    async release(record, claim) {
      await ctx.records.release(targetOf(record), claim);
    },
  };
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
    refusals: [...DRIVER_REFUSALS],
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
  if (holds(r.state)) return null;
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
 * forge. Returns why an end could not be written, for the report: the next
 * tick writes it.
 */
export async function settleOwnClaims(
  ctx: SharedContext,
  claims: DriveClaims,
  merged: readonly MarkedPr[],
  records: readonly ReadRecord[],
  outcomes: ReadonlyMap<number, FollowupOutcome>,
  nowIso: string,
): Promise<string[]> {
  const byId = new Map(records.map((r) => [r.record.id, r]));
  const ends = [
    ...driveEnds(claims, ctx.host, byId, nowIso),
    ...merged.flatMap((pr) =>
      ownOpenMarkers(pr, ctx.host, byId, outcomes.get(pr.number)).flatMap((m) =>
        owed(
          pr.number,
          "followup",
          m.id,
          markerEnd(m.run.record, outcomes.get(pr.number), byId, nowIso),
          m.run.host === undefined ? ctx.host : undefined,
        ),
      ),
    ),
  ];
  const failures: string[] = [];
  const unwritten = new Set<number>();
  for (const o of ends) {
    const r = await ctx.records.end(
      { repo: ctx.slug, pr: o.pr },
      o.stage,
      o.id,
      o.end,
      o.host,
    );
    if (!r.ok) {
      if (o.stage === "drive") unwritten.add(o.id);
      failures.push(
        `PR #${o.pr}: the end of claim comment ${o.id} could not be written: ${r.failure.reason}`,
      );
    }
  }
  settleEnds(
    settledRecords(claims, ctx.host, records, unwritten, nowIso),
    nowIso,
  );
  return failures;
}

/**
 * The finished drive records whose pull request's claims read and hold no
 * open claim of this host's for them with an end still unwritten: nothing is
 * owed on them, so their pull requests are not read to be ended again.
 */
function settledRecords(
  claims: DriveClaims,
  host: string,
  records: readonly ReadRecord[],
  unwritten: ReadonlySet<number>,
  nowIso: string,
): string[] {
  return records
    .filter((r) => {
      if (r.record.action === "followup" || r.record.pr === null) return false;
      if (endOfRecord(r, nowIso) === null || r.state.kind === "unknown")
        return false;
      const read = claims.get(Number(r.record.pr));
      if (read === undefined || !read.ok) return false;
      return !ownOpen(read, host).some(
        (c) => c.says.value.record === r.record.id && unwritten.has(c.id),
      );
    })
    .map((r) => r.record.id);
}

/** One end this host owes: its own claim's, on a pull request. */
interface OwedEnd {
  pr: number;
  stage: "drive" | "followup";
  id: number;
  end: LaunchEnd;
  /** The host to name on a marker that names none. */
  host?: string;
}

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
