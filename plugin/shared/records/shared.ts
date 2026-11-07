/**
 * Shared records: what a dispatching host publishes so that another host
 * dispatching the same repository can read it. A host keeps its launch
 * records, follow-up outcomes, walls and notification suppressions in its own
 * database, which no other host reads; what a second host needs to know is
 * who holds a launch and how it ended, and that travels here.
 *
 * The interface is the medium's whole surface for a dispatcher: claim a
 * launch, re-check the claim before an act, write the launch's end onto its
 * own claim, list the claims and their ends for a pull request or a
 * repository, and release a claim. Every method returns an `Outcome`
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)). The forge
 * is its first implementation (`shared-forge.ts`); a small control-plane
 * service joins behind the same interface when
 * [ADR-0013](../../../docs/adr/ADR-0013-records-not-a-daemon.md)'s conditions
 * for reopening hold.
 *
 * Two stages publish a claim here: a drive's launch (a re-arm, a re-drive, an
 * arm, a takeover), and a merge's follow-up, whose claim is the follow-up
 * marker. A pickup publishes none here: its shared record is the item's own
 * tracker claim, which `do-item` makes (it moves the item to its in-progress
 * state and assigns it), and which every host already reads.
 *
 * A drive's claims on one pull request are numbered by attempt: each new
 * launch claims the attempt after the latest, and of the claims on one
 * attempt the earliest trusted one wins. The latest attempt's winner is the
 * current claim; while it has no end, it holds the pull request's launches
 * for every host. A takeover alone may claim past a current claim with no
 * end, since the driver it replaces is wedged by definition.
 *
 * What these records are, and are not:
 *
 * - **They coordinate launches; they never authorize an act a person takes.**
 *   A claim says which host started a stage and how it ended, so no host
 *   starts it twice. Nothing reads a claim as leave to merge, to close an
 *   item or to skip a review, as the dispatch board's merge never rests on a
 *   drive's ledger alone.
 * - **The medium may offer no conditional create.** The forge has none for a
 *   comment, and its listing can lag behind a post. A claim is therefore read
 *   back after it is posted, again a bounded number of times while the
 *   listing does not show it, and re-checked before each act it guards; two
 *   hosts whose read-backs each lag past the other's claim can still both
 *   read themselves the holder of one launch. The backstop is the stage's own
 *   refusal: the drive's lock and its ledger's claim refuse a second driver,
 *   `do-item`'s claim refuses an item already taken, and a follow-up stops
 *   before its next act on an earlier marker.
 */
import type { Outcome } from "../outcome.ts";
import type { Writer } from "./writer.ts";

/** The stages that publish a claim here. */
export type SharedStage = "drive" | "followup";

/** Where a claim is made: a pull request of a repository. */
export interface SharedTarget {
  /** `owner/name`, or `{owner}/{repo}` for the checkout's own repository. */
  repo: string;
  pr: number;
}

/** How a launch ended, written onto its own claim by the host that made it. */
export type LaunchEnd =
  | {
      state: "ended";
      at: string;
      /** The stage's exit; `null` when it ended on a signal or has none (a follow-up a person ran). */
      exit: number | null;
      /** A follow-up's answer: `done`, or `failed` when its pass ended without recording done. */
      outcome: "done" | "failed" | null;
    }
  | {
      state: "died";
      at: string;
      reason: string;
      /** False only with durable evidence that the reservation never executed. Absent on older ends. */
      executed?: false;
    };

/** What a claim says. */
export interface ClaimSays {
  pr: number;
  /** The attempt it claims: a drive's attempt number; a follow-up has one claim, attempt 1. */
  attempt: number;
  /** When it was made; a claim in an earlier form may carry none (`""`). */
  at: string;
  /** `tick`: a dispatcher made it for its launch record; `manual`: a person's run did. */
  run: "tick" | "manual";
  action: "rearm" | "takeover" | "followup";
  /** The claiming host's launch record; `null` for a person's run. */
  record: string | null;
  /** The claiming host, as its claims name it; `null` where the claim names none. */
  host: string | null;
  /** Whether the claiming host owns the repository's board, notifications and history rows; `null` where it does not say. */
  owner: boolean | null;
  /** For a drive: the ledger facts its launch acted on. */
  facts: string | null;
  /** For a re-drive: the change it acts on, which is re-driven once. */
  change: string | null;
  /** For a re-drive: the changes an earlier launch of the same record acted on, which are not re-driven either. */
  earlier?: string[];
  /** For a re-drive of a drive that stopped on a conflict with its base. */
  conflictStop: boolean;
  /** How the launch ended; `null` while it has not, as far as its host has written. */
  end: LaunchEnd | null;
  /** Read in a form written before this one. */
  legacy: boolean;
}

/** One claim as the medium lists it. */
export interface SharedClaim {
  /** Its address on the medium; on the forge, the comment's id, the lower the earlier. */
  id: number;
  stage: SharedStage;
  login: string;
  createdAt: string;
  /** Written by the caller's own login, or by an author the medium vouches for. */
  trusted: boolean;
  /** What it says, or why it does not read. */
  says: Outcome<ClaimSays, "unreadable">;
}

/** A launch to claim. */
export interface LaunchDraft {
  stage: SharedStage;
  pr: number;
  run: "tick" | "manual";
  action: "rearm" | "takeover" | "followup";
  /** The claiming host's launch record; `null` for a person's run. */
  record: string | null;
  /** The claiming host, as its claims name it; `null` for a person's run. */
  host: string | null;
  owner: boolean | null;
  facts?: string | null;
  change?: string | null;
  earlier?: string[];
  conflictStop?: boolean;
  /** A replay of a launch record already made: a takeover then stands behind a later claim of another's instead of claiming past it. */
  replay?: boolean;
  /** The exits that mean a driver refused to run beside another: a current claim of another launch that ended on one, on the draft's own facts, answers it. */
  refusals?: readonly number[];
  writer: Writer;
}

/** The read-back's settings: how many more reads while the listing lags, how far apart. */
export interface ReadBackRule {
  retries?: number;
  delayMs?: number;
}

/**
 * How a claim came out. `holds`: the caller's claim wins its launch. `held`:
 * a current claim with no end held the launch, so nothing was posted. Every
 * other answer posted a claim (`id`) that the caller does not hold and
 * releases: `earlier`, a claim made first won; `missing`, the read-back never
 * listed it; `altered`, it no longer reads as posted; `unreadable`, the
 * read-back failed. `done` is a person's follow-up claim already marked done
 * before its read-back ended, which is kept as the completion it records.
 */
export type ClaimAnswer =
  | { kind: "holds"; id: number; attempt: number }
  | { kind: "held"; by: SharedClaim }
  | { kind: "earlier"; id: number; by: SharedClaim }
  | { kind: "missing"; id: number; reason: string }
  | { kind: "altered"; id: number; reason: string }
  | { kind: "unreadable"; id: number; reason: string }
  | { kind: "done"; id: number };

/** Why a claim could not be made: the claims did not read, or the post was refused or not named. */
export type ClaimCode = "unreadable" | "not-posted" | "no-claim-id";

/** How the caller's claim stands at a re-check: it holds, another claim won (`winner`), or the caller holds nothing (`reason`). */
export interface CheckAnswer {
  verdict: "holds" | "lost-to" | "lost";
  own: SharedClaim | null;
  winner: SharedClaim | null;
  reason: string;
}

/** One read or write a host made through the interface, for its receipt. */
export interface SharedOp {
  op: "list" | "claim" | "check" | "end" | "release" | "budget";
  /** What it was about: `PR #<n>`, or the repository. */
  target: string;
  ok: boolean;
}

/** What is left of the medium's budget, as the medium reports it. */
export interface SharedBudget {
  remaining: number;
  limit: number;
  /** When it is refilled. */
  resetAt: string;
}

/** The interface a dispatcher reads and writes shared records through. */
export interface SharedRecords {
  /** The medium, as the machine file's `records.shared` names it. */
  readonly medium: "forge";
  /** Every claim of `stage` on the pull request, trusted or not, earliest first. */
  list(
    target: SharedTarget,
    stage: SharedStage,
  ): Promise<Outcome<SharedClaim[], "unreadable">>;
  /** Every claim of `stage` on each of `prs`, by pull request; a pull request whose claims do not read carries why. */
  listRepository(
    repo: string,
    prs: readonly number[],
    stage: SharedStage,
  ): Promise<Map<number, Outcome<SharedClaim[], "unreadable">>>;
  /** Claim a launch, and read the claim back. */
  claim(
    target: SharedTarget,
    draft: LaunchDraft,
    rule?: ReadBackRule,
  ): Promise<Outcome<ClaimAnswer, ClaimCode>>;
  /** The re-read before an act the claim `own` guards. */
  check(
    target: SharedTarget,
    stage: SharedStage,
    own: number,
  ): Promise<Outcome<CheckAnswer, "unreadable">>;
  /** Write how a launch ended onto the caller's own claim `own`; `host` names the caller on a follow-up marker written before markers named their host. */
  end(
    target: SharedTarget,
    stage: SharedStage,
    own: number,
    end: LaunchEnd,
    host?: string,
  ): Promise<Outcome<void, "unreadable" | "not-own" | "not-written">>;
  /** Withdraw the caller's own claim `own`. */
  release(
    target: SharedTarget,
    own: number,
  ): Promise<Outcome<void, "not-released">>;
  /** What is left of the medium's budget. */
  budget(): Promise<Outcome<SharedBudget, "unreadable">>;
}

/** A trusted claim that reads, with what it says. */
export type ReadClaim = SharedClaim & { says: { ok: true; value: ClaimSays } };

/** The trusted claims that read, earliest first. */
export function readable(claims: readonly SharedClaim[]): ReadClaim[] {
  return claims.filter((c): c is ReadClaim => c.trusted && c.says.ok);
}

/** The trusted claims that do not read: each holds what it claims until a person settles it. */
export function unreadable(claims: readonly SharedClaim[]): SharedClaim[] {
  return claims.filter((c) => c.trusted && !c.says.ok);
}

/**
 * The winner of each attempt: of the trusted claims on one attempt, the
 * earliest. Earliest attempt first.
 */
export function winners(claims: readonly SharedClaim[]): ReadClaim[] {
  const won = new Map<number, ReadClaim>();
  for (const c of readable(claims).sort((a, b) => a.id - b.id)) {
    const attempt = c.says.value.attempt;
    if (!won.has(attempt)) won.set(attempt, c);
  }
  return [...won.values()].sort(
    (a, b) => a.says.value.attempt - b.says.value.attempt,
  );
}

/** The current claim: the latest attempt's winner; `null` when there is none. */
export function current(claims: readonly SharedClaim[]): ReadClaim | null {
  return winners(claims).at(-1) ?? null;
}

/** The attempt a new launch claims: the one after the latest any trusted claim names. */
export function nextAttempt(claims: readonly SharedClaim[]): number {
  return Math.max(0, ...readable(claims).map((c) => c.says.value.attempt)) + 1;
}

/** Every change a claim's re-drive acted on: the one it names now and the ones a replay moved on from. */
export function changesOf(says: ClaimSays): string[] {
  return [
    ...(says.change === null ? [] : [says.change]),
    ...(says.earlier ?? []),
  ];
}

/** Whether a claim's launch has no end yet, as its host has written. */
export function open(claim: ReadClaim): boolean {
  return claim.says.value.end === null;
}
