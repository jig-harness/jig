/**
 * The drives the forge wants re-armed, and the merges that want a
 * follow-up. Each open pull request's comments are read for its drive
 * ledger with drive-pr's own reader, trusting only a ledger the drive
 * trusts, and the ledger is classified from its driver's state and the exit
 * `drive.ts` wrote into it, named from drive-pr's terminal-state registry
 * (`DRIVE_EXIT`), first match wins:
 *
 * | Ledger says | Class |
 * | --- | --- |
 * | running, heartbeat inside the lease window | driven |
 * | running, heartbeat past the lease window | silent |
 * | stopped `CONVERGED` (`0`), the pull request conflicting or its head past the verified head | stale |
 * | stopped `PR_CONFLICTING` (`9`) | stale |
 * | stopped `CONVERGED` at the verified head and mergeable, `PR_NOT_OPEN` (`5`), `TAKEN_OVER` (`20`) | done |
 * | stopped with an explicit person's-stop record, `MAILBOX_STOPPED` (`18`), `MAILBOX_PAUSE_TIMEOUT` (`19`) | stopped-by-person |
 * | stopped with no exit and no person's-stop record | re-armable (stopped-unknown once its recovery budget is spent) |
 * | stopped `QUOTA_PARKED` (`16`) | re-armable |
 * | stopped `HITL_PARKED` (`8`), every parked item answered | re-armable |
 * | stopped `NOT_SETTLED` (`4`) | re-armable |
 * | stopped `HITL_PARKED`, an item unanswered | parked |
 * | stopped `SINGLE_INSTANCE_LOCK` (`11`), `DRIVE_HELD_BY_OTHER_WORKTREE` (`13`) | refused |
 * | stopped on any other exit | needs-person |
 *
 * A converged ledger is read beside what its stop does not fix: the pull
 * request's mergeability as the forge reports it, read with the pull
 * request, and its head commit against the head the ledger says the drive
 * verified (`verifiedSha`). A base that merely moved past a pull request
 * that still merges cleanly does not make it stale.
 *
 * A ledger that stopped `PR_CONFLICTING` is read beside its pull request's
 * mergeability, its head and its base branch's head, which is read for no
 * other ledger. Its change is the pair of heads, whatever the forge reports of
 * its mergeability: still conflicting, the drive's conflict-resolve round
 * tries again; mergeable, the stop no longer describes the pull request and
 * the drive's rounds take it from there. Once this machine re-drove that
 * change and the ledger still stopped `PR_CONFLICTING`, it is a person's
 * (`settleConflictStops`).
 *
 * A ledger that cannot be read (its comments, a version this reader does
 * not know, a damaged body, an unreadable heartbeat or park answer) is
 * `unplaced`: reported, never planned. So is a converged one whose
 * mergeability the forge is still computing, or whose head or verified head
 * is not known, since whether it is stale cannot be told this tick, and one
 * that stopped `PR_CONFLICTING` whose mergeability, head or base branch's head
 * is not known, since the change a re-drive would act on cannot be told.
 *
 * Where the repository turns dispatch labels on, each drive carries its
 * pull request's labels, and a pull request with no ledger that carries the
 * `drive` command label is `unarmed`: a person asked for a drive, and the
 * plan arms one. So is one the repository's adoption rule adopts
 * (`dispatch.adopt`, `adopt.ts`), whatever the labels. No state label is
 * read here.
 */
import { stallThresholdMs } from "../../../skills/drive-pr/scripts/lib/doctor.ts";
import { parkAnswers } from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type {
  Ledger,
  LedgerSnapshot,
} from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  readLedgerSnapshot,
  snapshotFromListing,
} from "../../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { type Adoption, adopts, type Author } from "../adopt.ts";
import { branchHead } from "../forge.ts";
import { hasCommand, type LabelConfig } from "../labels.ts";
import type { Listing } from "../tick-comments.ts";
import { failureText, minutesBetween } from "../text.ts";
import { framedDecisionLines } from "../../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import type {
  DrivenPr,
  Evidence,
  LedgerClass,
  StaleCause,
  WaitingPark,
} from "../types.ts";

/** What answers a park's items, when the ledger stopped `HITL_PARKED`. */
export type ParkReading =
  | { answered: number; waiting: string[]; parks?: WaitingPark[] }
  | { unreadable: string };

/** What the head of a pull request's base branch read as. */
type BaseHead = { oid: string } | { unreadable: string };

/** What the forge reports of an open pull request beside its ledger; `null` where it said nothing. */
export interface PrFacts {
  /** Its head commit. */
  head: string | null;
  /** `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while the forge computes it. */
  mergeable: string | null;
  /** The head of its base branch, read only for a ledger that stopped `PR_CONFLICTING`. */
  base?: BaseHead;
}

export interface Classified {
  class: LedgerClass;
  why: string;
  /** For `stale`: what its stop does not fix. */
  stale?: StaleCause;
}

const short = (sha: string) => sha.slice(0, 7);

/** What a ledger is read beside when the forge said nothing of its pull request. */
const NO_FACTS: PrFacts = { head: null, mergeable: null };

/** A pull request's mergeability and head commit as the forge reports them, or why they cannot place its stop yet. */
function readFacts({
  head,
  mergeable,
}: PrFacts): { head: string; conflicting: boolean } | { unread: string } {
  if (mergeable === "UNKNOWN")
    return {
      unread: "the forge is still computing whether it conflicts with its base",
    };
  if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING")
    return {
      unread: `the forge reports its mergeability as ${String(mergeable)}`,
    };
  if (head === null || head === "")
    return { unread: "the forge reports no head commit for it" };
  return { head, conflicting: mergeable === "CONFLICTING" };
}

/**
 * A converged ledger's class, read beside its pull request: `stale` when
 * the forge reports it conflicting with its base or its head is past the
 * head the drive verified, `done` when neither, and `unplaced` while
 * either cannot be told.
 */
function convergedClass(ledger: Ledger, forge: PrFacts): Classified {
  const verified = ledger.verifiedSha;
  const unplaced = (why: string): Classified => ({
    class: "unplaced",
    why: `stopped ${DRIVE_EXIT.CONVERGED} (converged), and ${why}, so whether it is stale cannot be told`,
  });
  const facts = readFacts(forge);
  if ("unread" in facts) return unplaced(facts.unread);
  const { head, conflicting } = facts;
  if (verified === "" && !conflicting)
    return unplaced("its ledger names no head the drive verified");
  const causes = [
    ...(conflicting ? ["conflicting with its base"] : []),
    ...(verified !== "" && head !== verified
      ? [`head ${short(head)} past the verified head ${short(verified)}`]
      : []),
  ];
  if (causes.length === 0)
    return {
      class: "done",
      why: `stopped ${DRIVE_EXIT.CONVERGED} (converged), still at the verified head ${short(verified)} and mergeable`,
    };
  const cause = causes.join(", and ");
  return {
    class: "stale",
    why: `stopped ${DRIVE_EXIT.CONVERGED} (converged), and now ${cause}: re-drive on any account`,
    stale: {
      cause,
      change: `head ${head}, ${conflicting ? "conflicting" : "mergeable"}`,
    },
  };
}

/**
 * A ledger that stopped `PR_CONFLICTING`, read beside its pull request: `stale`, conflicting
 * or not, keyed on the pair of its head and its base branch's head, and
 * `unplaced` while either or its mergeability cannot be told.
 */
function conflictStopClass(forge: PrFacts): Classified {
  const unplaced = (why: string): Classified => ({
    class: "unplaced",
    why: `stopped ${DRIVE_EXIT.PR_CONFLICTING} (conflicting with its base), and ${why}, so the change a re-drive would act on cannot be told`,
  });
  const facts = readFacts(forge);
  if ("unread" in facts) return unplaced(facts.unread);
  const base = forge.base ?? { unreadable: "it was not read" };
  if ("unreadable" in base)
    return unplaced(
      `the head of its base branch does not read (${base.unreadable})`,
    );
  const cause = facts.conflicting
    ? "stopped on a conflict with its base, and still conflicting"
    : "stopped on a conflict with its base, which the forge no longer reports";
  return {
    class: "stale",
    why: `${cause}: re-drive on any account, once for head ${short(facts.head)} and base ${short(base.oid)}`,
    stale: {
      cause,
      change: `head ${facts.head}, base ${base.oid}`,
      conflictStop: true,
    },
  };
}

/** The class of each exit the table names but `CONVERGED`, `HITL_PARKED` and `PR_CONFLICTING`, which read the pull request and its parks. */
const EXITS: Record<number, (ledger: Ledger) => Classified> = {
  [DRIVE_EXIT.PR_NOT_OPEN]: () => ({
    class: "done",
    why: `stopped ${DRIVE_EXIT.PR_NOT_OPEN} (merged or closed)`,
  }),
  [DRIVE_EXIT.TAKEN_OVER]: () => ({
    class: "done",
    why: `stopped ${DRIVE_EXIT.TAKEN_OVER} (taken over by another clone)`,
  }),
  [DRIVE_EXIT.MAILBOX_STOPPED]: () => ({
    class: "stopped-by-person",
    why: `stopped ${DRIVE_EXIT.MAILBOX_STOPPED} (a mailbox stop): a person's stop is never re-armed`,
  }),
  [DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT]: () => ({
    class: "stopped-by-person",
    why: `stopped ${DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT} (a mailbox pause): a person's stop is never re-armed`,
  }),
  [DRIVE_EXIT.QUOTA_PARKED]: (ledger) => ({
    class: "re-armable",
    why: `stopped ${DRIVE_EXIT.QUOTA_PARKED} (quota-parked; wall resets ${ledger.quotaPark?.resetAt ?? "at an unknown time"}): re-arm on an account other than the wall's, or after the reset`,
  }),
  [DRIVE_EXIT.NOT_SETTLED]: () => ({
    class: "re-armable",
    why: `stopped ${DRIVE_EXIT.NOT_SETTLED} (not judgeable yet): re-arm on any account`,
  }),
  [DRIVE_EXIT.SINGLE_INSTANCE_LOCK]: () => ({
    class: "refused",
    why: `stopped ${DRIVE_EXIT.SINGLE_INSTANCE_LOCK}: another driver holds it`,
  }),
  [DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE]: () => ({
    class: "refused",
    why: `stopped ${DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE}: another driver holds it`,
  }),
};

function runningClass(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
): Classified {
  const beat = Date.parse(ledger.driver.heartbeat);
  if (!Number.isFinite(beat))
    return { class: "unplaced", why: "its heartbeat is unreadable" };
  const age = minutesBetween(beat, nowMs);
  const window = Math.floor(windowMs / 60_000);
  return nowMs - beat <= windowMs
    ? {
        class: "driven",
        why: `heartbeat ${age} min old, inside the ${window}-min lease window`,
      }
    : {
        class: "silent",
        why: `heartbeat ${age} min old, past the ${window}-min lease window; neither a launch record of this machine nor another host's launch claim started its driver, so it is reported, not taken over`,
      };
}

function parkClass(park: ParkReading | undefined): Classified {
  if (park === undefined || "unreadable" in park)
    return {
      class: "unplaced",
      why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), and the answers to ${park === undefined ? "its parks" : park.unreadable} could not be read`,
    };
  return park.waiting.length === 0
    ? {
        class: "re-armable",
        why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), every parked item answered (${park.answered}): re-arm on any account`,
      }
    : {
        class: "parked",
        why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), waiting on ${park.waiting.join(", ")}: a person answers`,
      };
}

/** What a stop's evidence adds: the heads and the mergeability a ledger that stopped `CONVERGED` or `PR_CONFLICTING` was read beside. */
function stopEvidence(ledger: Ledger, forge: PrFacts): Evidence {
  if (ledger.driver.state !== "stopped") return {};
  const read = { headSha: forge.head, mergeable: forge.mergeable };
  if (ledger.driver.exit === DRIVE_EXIT.CONVERGED)
    return {
      verifiedSha: ledger.verifiedSha === "" ? null : ledger.verifiedSha,
      ...read,
    };
  if (ledger.driver.exit !== DRIVE_EXIT.PR_CONFLICTING) return {};
  const { base } = forge;
  return {
    baseSha: base !== undefined && "oid" in base ? base.oid : null,
    ...read,
  };
}

/** The evidence a report prints for one ledger. */
function ledgerEvidence(
  ledger: Ledger,
  nowMs: number,
  forge: PrFacts,
): Evidence {
  const beat = Date.parse(ledger.driver.heartbeat);
  return {
    ...stopEvidence(ledger, forge),
    generation: ledger.generation,
    round: ledger.round,
    phase: ledger.phase,
    driver: ledger.driver.state,
    exit: ledger.driver.exit ?? null,
    heartbeat: ledger.driver.heartbeat,
    started: ledger.driver.started ?? null,
    ...(ledger.driver.state === "stopped" &&
    ledger.driver.exit === undefined &&
    ledger.driver.personStop === undefined
      ? {
          noCause: true,
          legacyNoCause: ledger.driver.recoveryVersion === undefined,
        }
      : {}),
    heartbeatAgeMinutes: Number.isFinite(beat)
      ? minutesBetween(beat, nowMs)
      : null,
    parked: ledger.parked.length,
    quotaResetAt: ledger.quotaPark?.resetAt ?? null,
  };
}

/** A ledger's class, first match wins; `park` is read only for `HITL_PARKED`, `forge` only for `CONVERGED` and `PR_CONFLICTING`. */
export function classifyLedger(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
  park?: ParkReading,
  forge: PrFacts = NO_FACTS,
): Classified {
  const exit = ledger.driver.exit;
  if (ledger.driver.personStop !== undefined)
    return {
      class: "stopped-by-person",
      why:
        ledger.driver.state === "running"
          ? `stop requested by a person; driver still recorded running${ledger.driver.personStop.reason === "" ? "" : `: ${ledger.driver.personStop.reason}`}; the dispatcher will not re-arm it`
          : `stopped by a person${ledger.driver.personStop.reason === "" ? "" : `: ${ledger.driver.personStop.reason}`}; stays stopped until a person re-arms it`,
    };
  if (ledger.driver.state === "running")
    return runningClass(ledger, nowMs, windowMs);
  if (exit === undefined)
    return {
      class: "re-armable",
      why: "stopped with no recorded cause: re-arming within the per-pull-request recovery budget",
    };
  if (exit === DRIVE_EXIT.HITL_PARKED) return parkClass(park);
  if (exit === DRIVE_EXIT.CONVERGED) return convergedClass(ledger, forge);
  if (exit === DRIVE_EXIT.PR_CONFLICTING) return conflictStopClass(forge);
  return (
    EXITS[exit]?.(ledger) ?? {
      class: "needs-person",
      why: `stopped ${exit}: only a person settles it (see the drive's handoff)`,
    }
  );
}

export interface OpenPr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  /** Its head commit, as the forge reports it with the pull request. */
  headRefOid?: string;
  /** Its base branch, as the forge reports it with the pull request. */
  baseRefName?: string;
  /** Its mergeability with its base, as the forge reports it with the pull request. */
  mergeable?: string;
  /** Its labels, where the read asked for them. */
  labels?: string[];
  /** Its author, whether it is a draft and its last update, which the adoption rule reads. */
  author?: Author;
  isDraft?: boolean;
  updatedAt?: string;
}

/** Why a snapshot holds no ledger this reader can classify; `null` when it holds one, `""` when it holds none. */
function unreadable(snapshot: LedgerSnapshot): string | null {
  const canonical = snapshot.canonical;
  if (canonical === null)
    return snapshot.malformed.length > 0
      ? "its drive ledger comment does not read"
      : "";
  if (canonical.parsed.kind === "ledger") return null;
  return canonical.parsed.kind === "unknown-version"
    ? `its drive ledger is version ${String(canonical.parsed.version)}, which this reader does not know`
    : `its drive ledger does not read: ${canonical.parsed.reason}`;
}

async function parkOf(
  pr: number,
  ledger: Ledger,
  slug: string,
  listing: readonly unknown[] | undefined,
): Promise<ParkReading | undefined> {
  if (
    ledger.driver.state !== "stopped" ||
    ledger.driver.exit !== DRIVE_EXIT.HITL_PARKED
  )
    return undefined;
  const found = await parkAnswers(pr, ledger.parked, slug, listing);
  return "unreadable" in found
    ? found
    : {
        answered: found.answered.length,
        waiting: found.waiting.map((p) => `${p.kind} ${p.key}`),
        parks: found.waiting.map((p) => ({
          ...(p.person === undefined ? {} : { person: p.person }),
          key: p.key,
          kind: p.kind,
          lines: framedDecisionLines(p),
        })),
      };
}

/**
 * A pull request with no ledger whose `drive` label asks for one, or which
 * the repository's adoption rule adopts: the plan arms it once per head
 * commit.
 */
function unarmed(
  pr: OpenPr,
  base: Omit<DrivenPr, "class" | "why" | "evidence">,
  r: Pick<Reading, "labels" | "adoption" | "nowMs">,
): DrivenPr | null {
  const asked = askedToArm(pr, r);
  if (asked === null) return null;
  // The once-per-head rule needs the commit it arms: without one nothing starts.
  if (typeof pr.headRefOid !== "string" || pr.headRefOid === "")
    return {
      ...base,
      class: "unplaced",
      why: `no drive ledger, and ${asked.asks}, but the pull request's head commit does not read, so the once-per-head rule cannot be kept; nothing is armed`,
      evidence: {},
    };
  return {
    ...base,
    class: "unarmed",
    why: `no drive ledger, and ${asked.asks}: arm a drive on any account`,
    evidence: { ledger: "none", headSha: pr.headRefOid, ...asked.evidence },
  };
}

/** What asks for a pull request with no ledger to be armed: a person's `drive` label, else the adoption rule; `null` when nothing does. */
function askedToArm(
  pr: OpenPr,
  r: Pick<Reading, "labels" | "adoption" | "nowMs">,
): { asks: string; evidence: { adopted?: string } } | null {
  const { labels, adoption } = r;
  if (labels !== null && hasCommand(labels, pr.labels, "drive"))
    return { asks: "a person's drive label asks for one", evidence: {} };
  const adopted =
    adoption === null ? null : adopts(pr, adoption, labels, r.nowMs);
  return adopted === null
    ? null
    : {
        asks: "the repository's adoption rule (dispatch.adopt) adopts it",
        evidence: { adopted },
      };
}

/** What every drive of a pull request carries: the pull request, and its labels where they are read. */
function baseOf(
  pr: OpenPr,
  labels: LabelConfig | null,
): Omit<DrivenPr, "class" | "why" | "evidence"> {
  const base = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    head: pr.headRefName,
  };
  return labels === null ? base : { ...base, labels: pr.labels ?? [] };
}

/** What every drive of one reading shares. */
interface Reading {
  slug: string;
  login: string | null;
  nowMs: number;
  windowMs: number;
  labels: LabelConfig | null;
  /** The repository's adoption rule, where on. */
  adoption: Adoption | null;
  /** The head of a base branch, read at most once per reading. */
  baseHead: (branch: string | undefined) => Promise<BaseHead>;
  /** A pull request's comments as the tick listed them, shared with the other records read from them; absent, each read goes to the forge. */
  comments?: (pr: number) => Promise<Listing>;
}

/** A reading's reader of base branch heads: pull requests on one base share one read. */
function baseHeads(slug: string): Reading["baseHead"] {
  const read = new Map<string, Promise<BaseHead>>();
  return (branch) => {
    if (branch === undefined || branch === "")
      return Promise.resolve({
        unreadable: "the forge reports no base branch for it",
      });
    const known = read.get(branch);
    if (known !== undefined) return known;
    const head = branchHead(slug, branch).then(
      (oid): BaseHead => ({ oid }),
      (error: unknown): BaseHead => ({ unreadable: failureText(error) }),
    );
    read.set(branch, head);
    return head;
  };
}

/** What the forge reports of a pull request beside its ledger, its base branch's head for a ledger that stopped `PR_CONFLICTING`. */
async function factsOf(
  pr: OpenPr,
  ledger: Ledger,
  r: Reading,
): Promise<PrFacts> {
  const facts = {
    head: pr.headRefOid ?? null,
    mergeable: pr.mergeable ?? null,
  };
  return ledger.driver.state === "stopped" &&
    ledger.driver.exit === DRIVE_EXIT.PR_CONFLICTING
    ? { ...facts, base: await r.baseHead(pr.baseRefName) }
    : facts;
}

/** One pull request's drive; `null` when it carries no ledger and no label asks for one. */
async function driveOf(pr: OpenPr, r: Reading): Promise<DrivenPr | null> {
  const { slug, login, nowMs, windowMs, labels } = r;
  const base = baseOf(pr, labels);
  const listing = await r.comments?.(pr.number);
  const snapshot =
    listing === undefined
      ? await readLedgerSnapshot(String(pr.number), login, slug)
      : listing.ok
        ? snapshotFromListing(listing.value, login)
        : listing.failure.reason;
  if (typeof snapshot === "string")
    return { ...base, class: "unplaced", why: snapshot, evidence: {} };
  const why = unreadable(snapshot);
  if (why === "") return unarmed(pr, base, r);
  if (why !== null || snapshot.canonical?.parsed.kind !== "ledger")
    return { ...base, class: "unplaced", why: why ?? "", evidence: {} };
  const ledger = snapshot.canonical.parsed.ledger;
  const park = await parkOf(
    pr.number,
    ledger,
    slug,
    listing?.ok ? listing.value : undefined,
  );
  const forge = await factsOf(pr, ledger, r);
  const classified = classifyLedger(ledger, nowMs, windowMs, park, forge);
  return {
    ...base,
    ...classified,
    evidence: ledgerEvidence(ledger, nowMs, forge),
    ...waitingOf(classified, park, pr.author?.login),
  };
}

/** The unanswered decisions a parked ledger carries into its notification. */
function waitingOf(
  classified: Classified,
  park: ParkReading | undefined,
  author?: string,
): { waiting?: WaitingPark[] } {
  if (
    classified.class !== "parked" ||
    park === undefined ||
    "unreadable" in park
  )
    return {};
  return park.parks === undefined
    ? {}
    : {
        waiting: park.parks.map((p) =>
          p.person !== undefined || !author ? p : { ...p, person: author },
        ),
      };
}

/**
 * The open pull requests that carry a ledger, each classified; a pull
 * request with no ledger the drive trusts is not a drive and is left out,
 * unless `labels` are on and it carries the `drive` label, or `adoption`
 * adopts it (`unarmed`). Each pull request's comments are read through
 * `comments`, the tick's listings, where the observe phase passes them, and
 * from the forge where it does not, as a launch's fresh read does.
 */
export async function readDrives(
  slug: string,
  login: string | null,
  prs: readonly OpenPr[],
  nowMs: number,
  labels: LabelConfig | null = null,
  adoption: Adoption | null = null,
  comments?: (pr: number) => Promise<Listing>,
): Promise<DrivenPr[]> {
  const reading: Reading = {
    slug,
    login,
    nowMs,
    windowMs: stallThresholdMs(),
    labels,
    adoption,
    baseHead: baseHeads(slug),
    ...(comments === undefined ? {} : { comments }),
  };
  const out: DrivenPr[] = [];
  for (const pr of prs) {
    const drive = await driveOf(pr, reading);
    if (drive !== null) out.push(drive);
  }
  return out;
}
