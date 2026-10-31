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
 * | stopped `0`, `5`, `20` | done |
 * | stopped `18`, `19` | stopped-by-person |
 * | stopped with no exit | stopped-unknown |
 * | stopped `16` | re-armable |
 * | stopped `8`, every parked item answered | re-armable |
 * | stopped `4` | re-armable |
 * | stopped `8`, an item unanswered | parked |
 * | stopped `11`, `13` | refused |
 * | stopped on any other exit | needs-person |
 *
 * A ledger that cannot be read (its comments, a version this reader does
 * not know, a damaged body, an unreadable heartbeat or park answer) is
 * `unplaced`: reported, never planned.
 */
import { stallThresholdMs } from "../../../skills/drive-pr/scripts/lib/doctor.ts";
import { parkAnswers } from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type {
  Ledger,
  LedgerSnapshot,
} from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { readLedgerSnapshot } from "../../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { minutesBetween } from "../text.ts";
import type { DrivenPr, Evidence, LedgerClass } from "../types.ts";

/** What answers a park's items, when the ledger stopped `8`. */
export type ParkReading =
  { answered: number; waiting: string[] } | { unreadable: string };

export interface Classified {
  class: LedgerClass;
  why: string;
}

/** The class of each exit the table names but `8`, which reads its parks. */
const EXITS: Record<number, (ledger: Ledger) => Classified> = {
  0: () => ({ class: "done", why: "stopped 0 (converged)" }),
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

/** The evidence a report prints for one ledger. */
function ledgerEvidence(ledger: Ledger, nowMs: number): Evidence {
  const beat = Date.parse(ledger.driver.heartbeat);
  return {
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

/** A ledger's class, first match wins; `park` is read only for exit `8`. */
export function classifyLedger(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
  park?: ParkReading,
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
    : { answered: found.answered.length, waiting: found.waiting };
}

/** One pull request's drive; `null` when it carries no ledger. */
async function driveOf(
  pr: OpenPr,
  slug: string,
  login: string | null,
  nowMs: number,
  windowMs: number,
): Promise<DrivenPr | null> {
  const base = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    head: pr.headRefName,
  };
  const snapshot = await readLedgerSnapshot(String(pr.number), login, slug);
  if (typeof snapshot === "string")
    return { ...base, class: "unplaced", why: snapshot, evidence: {} };
  const why = unreadable(snapshot);
  if (why === "") return null;
  if (why !== null || snapshot.canonical?.parsed.kind !== "ledger")
    return { ...base, class: "unplaced", why: why ?? "", evidence: {} };
  const ledger = snapshot.canonical.parsed.ledger;
  const park = await parkOf(pr.number, ledger, slug);
  return {
    ...base,
    ...classifyLedger(ledger, nowMs, windowMs, park),
    evidence: ledgerEvidence(ledger, nowMs),
  };
}

/**
 * The open pull requests that carry a ledger, each classified; a pull
 * request with no ledger the drive trusts is not a drive and is left out.
 */
export async function readDrives(
  slug: string,
  login: string | null,
  prs: readonly OpenPr[],
  nowMs: number,
): Promise<DrivenPr[]> {
  const window = stallThresholdMs();
  const out: DrivenPr[] = [];
  for (const pr of prs) {
    const drive = await driveOf(pr, slug, login, nowMs, window);
    if (drive !== null) out.push(drive);
  }
  return out;
}
