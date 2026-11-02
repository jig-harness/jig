/**
 * The drives the forge wants re-armed, and the merges that want a
 * follow-up. Each open pull request's comments are read for its drive
 * ledger with drive-pr's own reader, trusting only a ledger the drive
 * trusts, and the ledger is classified from its driver's state and the exit
 * `drive.ts` wrote into it, first match wins:
 *
 * | Ledger says | Class |
 * | --- | --- |
 * | running, heartbeat inside the lease window | driven |
 * | running, heartbeat past the lease window | silent |
 * | stopped `0`, the pull request conflicting or its head past the verified head | stale |
 * | stopped `0` (at the verified head, mergeable), `5`, `20` | done |
 * | stopped `18`, `19` | stopped-by-person |
 * | stopped with no exit | stopped-unknown |
 * | stopped `16` | re-armable |
 * | stopped `8`, every parked item answered | re-armable |
 * | stopped `4` | re-armable |
 * | stopped `8`, an item unanswered | parked |
 * | stopped `11`, `13` | refused |
 * | stopped on any other exit | needs-person |
 *
 * A converged ledger is read beside what its stop does not fix: the pull
 * request's mergeability as the forge reports it, read with the pull
 * request, and its head commit against the head the ledger says the drive
 * verified (`verifiedSha`). A base that merely moved past a pull request
 * that still merges cleanly does not make it stale.
 *
 * A ledger that cannot be read (its comments, a version this reader does
 * not know, a damaged body, an unreadable heartbeat or park answer) is
 * `unplaced`: reported, never planned. So is a converged one whose
 * mergeability the forge is still computing, or whose head or verified head
 * is not known: whether it is stale cannot be told this tick.
 *
 * Where the repository turns dispatch labels on, each drive carries its
 * pull request's labels, and a pull request with no ledger that carries the
 * `drive` command label is `unarmed`: a person asked for a drive, and the
 * plan arms one. No state label is read here.
 */
import { stallThresholdMs } from "../../../skills/drive-pr/scripts/lib/doctor.ts";
import { parkAnswers } from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type {
  Ledger,
  LedgerSnapshot,
} from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { readLedgerSnapshot } from "../../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { hasCommand, type LabelConfig } from "../labels.ts";
import { minutesBetween } from "../text.ts";
import { framedDecisionLines } from "../../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import type {
  DrivenPr,
  Evidence,
  LedgerClass,
  StaleCause,
  WaitingPark,
} from "../types.ts";

/** What answers a park's items, when the ledger stopped `8`. */
export type ParkReading =
  | { answered: number; waiting: string[]; parks?: WaitingPark[] }
  | { unreadable: string };

/** What the forge reports of an open pull request beside its ledger; `null` where it said nothing. */
export interface PrFacts {
  /** Its head commit. */
  head: string | null;
  /** `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while the forge computes it. */
  mergeable: string | null;
}

export interface Classified {
  class: LedgerClass;
  why: string;
  /** For `stale`: what its stop does not fix. */
  stale?: StaleCause;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * A converged ledger's class, read beside its pull request: `stale` when
 * the forge reports it conflicting with its base or its head is past the
 * head the drive verified, `done` when neither, and `unplaced` while
 * either cannot be told.
 */
function convergedClass(
  ledger: Ledger,
  forge: PrFacts | undefined,
): Classified {
  const verified = ledger.verifiedSha;
  const head = forge?.head ?? null;
  const mergeable = forge?.mergeable ?? null;
  const unplaced = (why: string): Classified => ({
    class: "unplaced",
    why: `stopped 0 (converged), and ${why}, so whether it is stale cannot be told`,
  });
  if (mergeable === "UNKNOWN")
    return unplaced(
      "the forge is still computing whether it conflicts with its base",
    );
  if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING")
    return unplaced(
      `the forge reports its mergeability as ${String(mergeable)}`,
    );
  if (head === null || head === "")
    return unplaced("the forge reports no head commit for it");
  const conflicting = mergeable === "CONFLICTING";
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
      why: `stopped 0 (converged), still at the verified head ${short(verified)} and mergeable`,
    };
  const cause = causes.join(", and ");
  return {
    class: "stale",
    why: `stopped 0 (converged), and now ${cause}: re-drive on any account`,
    stale: { cause, change: `head ${head}, ${mergeable.toLowerCase()}` },
  };
}

/** The class of each exit the table names but `0` and `8`, which read the pull request and its parks. */
const EXITS: Record<number, (ledger: Ledger) => Classified> = {
  5: () => ({ class: "done", why: "stopped 5 (merged or closed)" }),
  20: () => ({
    class: "done",
    why: "stopped 20 (taken over by another clone)",
  }),
  18: () => ({
    class: "stopped-by-person",
    why: "stopped 18 (a mailbox stop): a person's stop is never re-armed",
  }),
  19: () => ({
    class: "stopped-by-person",
    why: "stopped 19 (a mailbox pause): a person's stop is never re-armed",
  }),
  16: (ledger) => ({
    class: "re-armable",
    why: `stopped 16 (quota-parked; wall resets ${ledger.quotaPark?.resetAt ?? "at an unknown time"}): re-arm on an account other than the wall's, or after the reset`,
  }),
  4: () => ({
    class: "re-armable",
    why: "stopped 4 (not judgeable yet): re-arm on any account",
  }),
  11: () => ({ class: "refused", why: "stopped 11: another driver holds it" }),
  13: () => ({ class: "refused", why: "stopped 13: another driver holds it" }),
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
        why: `heartbeat ${age} min old, past the ${window}-min lease window; no launch record of this machine started its driver, so it is reported, not taken over`,
      };
}

function parkClass(park: ParkReading | undefined): Classified {
  if (park === undefined || "unreadable" in park)
    return {
      class: "unplaced",
      why: `stopped 8 (parked), and the answers to ${park === undefined ? "its parks" : park.unreadable} could not be read`,
    };
  return park.waiting.length === 0
    ? {
        class: "re-armable",
        why: `stopped 8 (parked), every parked item answered (${park.answered}): re-arm on any account`,
      }
    : {
        class: "parked",
        why: `stopped 8 (parked), waiting on ${park.waiting.join(", ")}: a person answers`,
      };
}

/** The evidence a report prints for one ledger; a converged one's carries the heads and the mergeability it was read beside. */
function ledgerEvidence(
  ledger: Ledger,
  nowMs: number,
  forge: PrFacts | undefined,
): Evidence {
  const beat = Date.parse(ledger.driver.heartbeat);
  const converged =
    ledger.driver.state === "stopped" && ledger.driver.exit === 0
      ? {
          verifiedSha: ledger.verifiedSha === "" ? null : ledger.verifiedSha,
          headSha: forge?.head ?? null,
          mergeable: forge?.mergeable ?? null,
        }
      : {};
  return {
    ...converged,
    generation: ledger.generation,
    round: ledger.round,
    phase: ledger.phase,
    driver: ledger.driver.state,
    exit: ledger.driver.exit ?? null,
    heartbeat: ledger.driver.heartbeat,
    started: ledger.driver.started ?? null,
    heartbeatAgeMinutes: Number.isFinite(beat)
      ? minutesBetween(beat, nowMs)
      : null,
    parked: ledger.parked.length,
    quotaResetAt: ledger.quotaPark?.resetAt ?? null,
  };
}

/** A ledger's class, first match wins; `park` is read only for exit `8`, `forge` only for exit `0`. */
export function classifyLedger(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
  park?: ParkReading,
  forge?: PrFacts,
): Classified {
  if (ledger.driver.state === "running")
    return runningClass(ledger, nowMs, windowMs);
  const exit = ledger.driver.exit;
  if (exit === undefined)
    return {
      class: "stopped-unknown",
      why: "stopped with no exit, which may be a person's stop: never re-armed",
    };
  if (exit === 8) return parkClass(park);
  if (exit === 0) return convergedClass(ledger, forge);
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
  /** Its mergeability with its base, as the forge reports it with the pull request. */
  mergeable?: string;
  /** Its labels, where the read asked for them. */
  labels?: string[];
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
): Promise<ParkReading | undefined> {
  if (ledger.driver.state !== "stopped" || ledger.driver.exit !== 8)
    return undefined;
  const found = await parkAnswers(pr, ledger.parked, slug);
  return "unreadable" in found
    ? found
    : {
        answered: found.answered.length,
        waiting: found.waiting.map((p) => `${p.kind} ${p.key}`),
        parks: found.waiting.map((p) => ({
          key: p.key,
          kind: p.kind,
          lines: framedDecisionLines(p),
        })),
      };
}

/** A pull request with no ledger whose `drive` label asks for one: the plan arms it once per head commit. */
function unarmed(
  pr: OpenPr,
  base: Omit<DrivenPr, "class" | "why" | "evidence">,
  labels: LabelConfig | null,
): DrivenPr | null {
  if (labels === null || !hasCommand(labels, pr.labels, "drive")) return null;
  return {
    ...base,
    class: "unarmed",
    why: "no drive ledger, and a person's drive label asks for one: arm a drive on any account",
    evidence: { ledger: "none", headSha: pr.headRefOid ?? null },
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

/** One pull request's drive; `null` when it carries no ledger and no label asks for one. */
async function driveOf(
  pr: OpenPr,
  slug: string,
  login: string | null,
  nowMs: number,
  windowMs: number,
  labels: LabelConfig | null,
): Promise<DrivenPr | null> {
  const base = baseOf(pr, labels);
  const snapshot = await readLedgerSnapshot(String(pr.number), login, slug);
  if (typeof snapshot === "string")
    return { ...base, class: "unplaced", why: snapshot, evidence: {} };
  const why = unreadable(snapshot);
  if (why === "") return unarmed(pr, base, labels);
  if (why !== null || snapshot.canonical?.parsed.kind !== "ledger")
    return { ...base, class: "unplaced", why: why ?? "", evidence: {} };
  const ledger = snapshot.canonical.parsed.ledger;
  const park = await parkOf(pr.number, ledger, slug);
  const forge: PrFacts = {
    head: pr.headRefOid ?? null,
    mergeable: pr.mergeable ?? null,
  };
  const classified = classifyLedger(ledger, nowMs, windowMs, park, forge);
  return {
    ...base,
    ...classified,
    evidence: ledgerEvidence(ledger, nowMs, forge),
    ...waitingOf(classified, park),
  };
}

/** The unanswered decisions a parked ledger carries into its notification. */
function waitingOf(
  classified: Classified,
  park: ParkReading | undefined,
): { waiting?: WaitingPark[] } {
  if (
    classified.class !== "parked" ||
    park === undefined ||
    "unreadable" in park
  )
    return {};
  return park.parks === undefined ? {} : { waiting: park.parks };
}

/**
 * The open pull requests that carry a ledger, each classified; a pull
 * request with no ledger the drive trusts is not a drive and is left out,
 * unless `labels` are on and it carries the `drive` label (`unarmed`).
 */
export async function readDrives(
  slug: string,
  login: string | null,
  prs: readonly OpenPr[],
  nowMs: number,
  labels: LabelConfig | null = null,
): Promise<DrivenPr[]> {
  const window = stallThresholdMs();
  const out: DrivenPr[] = [];
  for (const pr of prs) {
    const drive = await driveOf(pr, slug, login, nowMs, window, labels);
    if (drive !== null) out.push(drive);
  }
  return out;
}
