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
 * | running, heartbeat past the lease window | silent, read beside whether this host shows its driver gone |
 * | stopped `CONVERGED` (`0`), the pull request conflicting or its head past the verified head | stale |
 * | stopped `PR_CONFLICTING` (`9`) | stale |
 * | stopped `STALLED` (`14`), `CI_REPAIR_SPENT` (`21`), `PASS_DEADLINE` (`15`) | stale, once per head commit |
 * | stopped `INDETERMINATE` (`1`), the pull request conflicting with its base | stale, once per head and base head |
 * | stopped `CONVERGED` at the verified head and mergeable, `PR_NOT_OPEN` (`5`), `TAKEN_OVER` (`20`) | done |
 * | stopped with an explicit person's-stop record, `MAILBOX_STOPPED` (`18`), `MAILBOX_PAUSE_TIMEOUT` (`19`) | stopped-by-person |
 * | stopped with no exit and no person's-stop record | re-armable (stopped-unknown once its recovery budget is spent) |
 * | stopped `QUOTA_PARKED` (`16`) | re-armable |
 * | stopped `HITL_PARKED` (`8`), every parked item answered | re-armable |
 * | stopped `NOT_SETTLED` (`4`) | re-armable |
 * | stopped `WORKTREE_UNCLEAN` (`12`), head known and not yet recovered | stale: settle original tree once per head |
 * | stopped `HITL_PARKED`, an item unanswered, the pull request conflicting with its base | stale |
 * | stopped `HITL_PARKED`, an item unanswered | parked |
 * | stopped `SINGLE_INSTANCE_LOCK` (`11`), `DRIVE_HELD_BY_OTHER_WORKTREE` (`13`) | refused |
 * | stopped `REVIEW_SKIPPED` (`22`) | needs-person, naming the skip |
 * | stopped on any other exit | needs-person, saying so when the pull request conflicts with its base |
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
 * A parked ledger is read beside its pull request's mergeability too: a
 * pull request waiting on a person must not also wait on a merge of its
 * base. Conflicting, it is re-driven like a stop on a conflict, once for each
 * pair of its head and its base branch's head: the drive's first gate
 * reports the conflict before the park, its conflict-resolve round merges
 * the base if repair succeeds, then the drive parks on unanswered questions. A
 * re-drive that leaves it parked or stopped `PR_CONFLICTING` at the same pair
 * hands it back to a person (`settleConflictStops`): a conflict the drive
 * could not resolve, such as two requirements that contradict each other, is
 * that person's decision too.
 *
 * A ledger that stopped `STALLED` or `CI_REPAIR_SPENT` is a stop the drive's
 * own next step settles: a pass that finds why the stalled passes did not
 * act, or a CI repair with a fresh budget. Its change is its head commit and
 * its exit, so it is re-driven once for each; once this machine or another
 * host re-drove that change and the ledger still stopped the same way, it is
 * a person's (`settleConflictStops`). A stall whose stop recorded work left
 * in its tree, or never measured it (the ledger's last `stop` event,
 * `leftWork`), names that tree, where its re-drive must run
 * (`stall-tree.ts`). One whose head is not known
 * is `unplaced`.

 *
 * A ledger that stopped `PASS_DEADLINE`, the driver having spent its
 * restarts from a pass killed at its deadline, is re-driven the same way,
 * once per head commit, by a fresh pass, in the tree it stopped in when its
 * stop measured work left there, since the killed passes' work stays there. One that stopped `INDETERMINATE`
 * (`1`) while its pull request conflicts with its base is re-driven once per
 * pair of its head and its base branch's head, the change a stop on a
 * conflict is keyed on, so the drive's conflict-resolve round runs once for
 * it; its base branch's head is read for it, and
 * while the forge still computes its mergeability it is `unplaced`. Both
 * re-drives draw on the pull request's recovery budget (`recovery`,
 * `no-cause-stops.ts`).
 *
 * A silent ledger is read beside what this host shows of the driver it names
 * (`silent-driver.ts`): `driverGone` where the driver ran on this host and
 * this host shows its run ended, which the plan takes over (a re-drive the
 * recovery budget counts), and the reason it cannot where it does not.
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
import { lastStopEvent } from "../../../skills/drive-pr/scripts/lib/state/events.ts";
import { ledgerTree } from "../stall-tree.ts";
import { type DriverPresence, driverPresence } from "./silent-driver.ts";
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
  /** The head of its base branch, read only for a ledger whose stop a conflict re-drives (`readsBaseHead`). */
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

/** A stop on a conflict, re-driven once for the pair of heads it was read at. */
function conflictRedrive(
  cause: string,
  { facts, base }: { facts: { head: string }; base: { oid: string } },
): Classified {
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

/**
 * A ledger that stopped `PR_CONFLICTING`, read beside its pull request: `stale`, conflicting
 * or not, keyed on the pair of its head and its base branch's head, and
 * `unplaced` while either or its mergeability cannot be told.
 */
function conflictStopClass(forge: PrFacts): Classified {
  const pair = conflictPair(forge);
  if ("unread" in pair)
    return {
      class: "unplaced",
      why: `stopped ${DRIVE_EXIT.PR_CONFLICTING} (conflicting with its base), and ${pair.unread}, so the change a re-drive would act on cannot be told`,
    };
  return conflictRedrive(
    pair.facts.conflicting
      ? "stopped on a conflict with its base, and still conflicting"
      : "stopped on a conflict with its base, which the forge no longer reports",
    pair,
  );
}

/** The pair of heads a stop on a conflict is keyed on, with the pull request's mergeability, or why it cannot be told. */
function conflictPair(
  forge: PrFacts,
):
  | { facts: { head: string; conflicting: boolean }; base: { oid: string } }
  | { unread: string } {
  const facts = readFacts(forge);
  if ("unread" in facts) return facts;
  const base = forge.base ?? { unreadable: "it was not read" };
  return "unreadable" in base
    ? {
        unread: `the head of its base branch does not read (${base.unreadable})`,
      }
    : { facts, base };
}

/** The exit a drive stops on when nothing more specific names its stop. */
const FAILED = DRIVE_EXIT.INDETERMINATE;

/**
 * A ledger that stopped `1`, read beside its pull request: `stale` while
 * the pull request conflicts with its base, keyed on the pair of its head
 * and its base branch's head as a stop on a conflict is, so its
 * conflict-resolve round runs once for that pair whichever stop asked for
 * it; `unplaced` while the forge still computes its mergeability or that
 * pair cannot be told; `null` when it does not conflict, a person's as any
 * other stop is.
 */
function failedConflictClass(forge: PrFacts): Classified | null {
  if (forge.mergeable !== "CONFLICTING" && forge.mergeable !== "UNKNOWN")
    return null;
  const pair = conflictPair(forge);
  if ("unread" in pair)
    return {
      class: "unplaced",
      why: `stopped ${FAILED}, and ${pair.unread}, so whether its conflict-resolve round settles it cannot be told`,
    };
  const { facts, base } = pair;
  return {
    class: "stale",
    why: `stopped ${FAILED}, and its pull request conflicts with its base: re-drive on any account, so its conflict-resolve round runs, once for head ${short(facts.head)} and base ${short(base.oid)}`,
    stale: {
      cause: `stopped ${FAILED}, and its pull request conflicts with its base`,
      // The pair a stop on a conflict is keyed on: either stop's re-drive ran the conflict-resolve round for it.
      change: `head ${facts.head}, base ${base.oid}`,
      conflictStop: true,
      recovery: true,
    },
  };
}

/** Whether a ledger's stop is read beside its base branch's head: a stop on a conflict, or a park or a failure on a pull request the forge reports conflicting. */
export function readsBaseHead(
  ledger: Ledger,
  mergeable: string | null | undefined,
): boolean {
  if (ledger.driver.state !== "stopped") return false;
  const exit = ledger.driver.exit;
  return (
    exit === DRIVE_EXIT.PR_CONFLICTING ||
    (exit === DRIVE_EXIT.HITL_PARKED && mergeable === "CONFLICTING") ||
    (exit === FAILED &&
      ledger.driver.personStop === undefined &&
      mergeable === "CONFLICTING")
  );
}

/** The stops a re-drive settles once per head commit, by exit: what each is, in words, and whether it draws on the recovery budget. */
const MECHANICAL_STOPS: ReadonlyMap<
  number,
  {
    kind: NonNullable<StaleCause["mechanicalStop"]>;
    words: string;
    recovery?: true;
  }
> = new Map([
  [DRIVE_EXIT.STALLED, { kind: "stall", words: "stalled" }],
  [
    DRIVE_EXIT.CI_REPAIR_SPENT,
    {
      kind: "ci-repair",
      words: "CI still failing with its repair passes spent",
    },
  ],
  [
    DRIVE_EXIT.PASS_DEADLINE,
    {
      kind: "deadline",
      words: "a pass reached its deadline with its restarts spent",
      recovery: true,
    },
  ],
]);

/** What a needs-person reason adds when the pull request conflicts with its base. */
export function conflictNote(mergeable: unknown): string {
  return mergeable === "CONFLICTING"
    ? "; its pull request also conflicts with its base"
    : "";
}

function stopTreeWhy(leftWork: boolean | undefined): string {
  return leftWork === true
    ? "in the tree it stopped in, which holds work it left"
    : "in the tree it stopped in, whose work was never measured";
}

/**
 * A ledger that stopped `STALLED`, `CI_REPAIR_SPENT` or `PASS_DEADLINE`,
 * read beside its pull request's head: `stale`, keyed on that head and the
 * exit, and `unplaced` while the head is not known.
 */
function mechanicalStopClass(
  ledger: Ledger,
  exit: number,
  forge: PrFacts,
): Classified | null {
  const stop = MECHANICAL_STOPS.get(exit);
  if (stop === undefined) return null;
  const head = forge.head;
  if (head === null || head === "")
    return {
      class: "unplaced",
      why: `stopped ${exit} (${stop.words}), and the forge reports no head commit for it, so the once-per-head re-drive cannot be kept`,
    };
  const last = lastStopEvent(ledger.events ?? []);
  const tree = boundToTree(stop.kind, exit, last) ? ledgerTree(ledger) : null;
  return {
    class: "stale",
    why: `stopped ${exit} (${stop.words}): re-drive ${tree === null ? "on any account" : stopTreeWhy(last?.leftWork)}, once for head ${short(head)}`,
    stale: {
      cause: `stopped ${exit}, ${stop.words}`,
      change: `head ${head}, stopped ${exit}`,
      mechanicalStop: stop.kind,
      ...(stop.recovery === true ? { recovery: true as const } : {}),
      ...(tree === null ? {} : { tree }),
    },
  };
}

/**
 * Whether a mechanical stop's re-drive must run in the tree it stopped in: a
 * stall that left work there or never measured it, and a pass deadline whose
 * stop measured work left. A deadline stop that never measured comes from a
 * driver that did not record it, so it re-drives on any account.
 */
function boundToTree(
  kind: NonNullable<StaleCause["mechanicalStop"]>,
  exit: number,
  last: ReturnType<typeof lastStopEvent>,
): boolean {
  const own = last === undefined || last.cause === String(exit);
  if (kind === "stall") return own && last?.leftWork !== false;
  return kind === "deadline" && own && last?.leftWork === true;
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
  [DRIVE_EXIT.REVIEW_SKIPPED]: () => ({
    class: "needs-person",
    why: `stopped ${DRIVE_EXIT.REVIEW_SKIPPED} (the reviewer skipped its head, and its review of an earlier head does not cover it): a re-arm waits for a review that will not come, so a person has the reviewer review the head or pushes a commit it reviews (see the drive's handoff)`,
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
        why: `heartbeat ${age} min old, past the ${window}-min lease window`,
      };
}

function parkClass(park: ParkReading | undefined, forge: PrFacts): Classified {
  if (park === undefined || "unreadable" in park)
    return {
      class: "unplaced",
      why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), and the answers to ${park === undefined ? "its parks" : park.unreadable} could not be read`,
    };
  if (park.waiting.length === 0)
    return {
      class: "re-armable",
      why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), every parked item answered (${park.answered}): re-arm on any account`,
    };
  const waiting = `waiting on ${park.waiting.join(", ")}`;
  return (
    parkConflictClass(waiting, forge) ?? {
      class: "parked",
      why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), ${waiting}: a person answers`,
    }
  );
}

/**
 * A park whose pull request conflicts with its base: `stale`, keyed on the
 * pair of its head and its base branch's head, so the drive merges the base
 * if repair succeeds, then parks; `unplaced` while that pair cannot be told; `null` while
 * the forge does not report it conflicting, mergeability still computing
 * included, so the park stands.
 */
function parkConflictClass(waiting: string, forge: PrFacts): Classified | null {
  if (forge.mergeable !== "CONFLICTING") return null;
  const pair = conflictPair(forge);
  if ("unread" in pair)
    return {
      class: "unplaced",
      why: `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), ${waiting}, and conflicting with its base, but ${pair.unread}, so the change a re-drive would act on cannot be told`,
    };
  return conflictRedrive(
    `parked ${waiting}, and conflicting with its base`,
    pair,
  );
}

/** What a stop's evidence adds: the heads and the mergeability a ledger whose stop the forge's read places (`CONVERGED`, a conflict, a mechanical stop) was read beside. */
function stopEvidence(ledger: Ledger, forge: PrFacts): Evidence {
  if (ledger.driver.state !== "stopped") return {};
  const read = { headSha: forge.head, mergeable: forge.mergeable };
  if (MECHANICAL_STOPS.has(ledger.driver.exit ?? Number.NaN)) return read;
  if (ledger.driver.exit === DRIVE_EXIT.CONVERGED)
    return {
      verifiedSha: ledger.verifiedSha === "" ? null : ledger.verifiedSha,
      ...read,
    };
  if (ledger.driver.exit === DRIVE_EXIT.WORKTREE_UNCLEAN) return read;
  if (!readsBaseHead(ledger, forge.mergeable)) return {};
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
    driverActor: ledger.driver.actor,
    driverClone: ledger.driver.clone,
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

/** An unclean stop gets one recovery for its known head. */
function uncleanClass(ledger: Ledger, forge: PrFacts): Classified {
  if (forge.head === null || forge.head === "")
    return {
      class: "unplaced",
      why: "stopped 12, but its head is unknown: the once-per-head recovery cannot be kept",
    };
  return {
    class: "stale",
    why: "stopped 12 (worktree unclean): settle the existing tree once at this head",
    stale: {
      cause: "stopped 12, uncommitted work in the original tree",
      change: `unclean head ${forge.head}`,
      uncleanTree: true,
      tree: ledgerTree(ledger),
    },
  };
}

/** A recorded operator stop takes precedence over every automatic recovery. */
function personStopClass(ledger: Ledger): Classified {
  const reason = ledger.driver.personStop?.reason ?? "";
  const detail = reason === "" ? "" : `: ${reason}`;
  return {
    class: "stopped-by-person",
    why:
      ledger.driver.state === "running"
        ? `stop requested by a person; driver still recorded running${detail}; the dispatcher will not re-arm it`
        : `stopped by a person${detail}; stays stopped until a person re-arms it`,
  };
}

/** A ledger's class, first match wins; `park` is read only for `HITL_PARKED`; `forge` for `CONVERGED`, the conflicts, the parks on a conflict, unclean trees and the stops a re-drive settles, and for a needs-person stop's mergeability. */
export function classifyLedger(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
  park?: ParkReading,
  forge: PrFacts = NO_FACTS,
): Classified {
  const exit = ledger.driver.exit;
  if (ledger.driver.personStop !== undefined) return personStopClass(ledger);
  if (ledger.driver.state === "running")
    return runningClass(ledger, nowMs, windowMs);
  if (exit === undefined)
    return {
      class: "re-armable",
      why: "stopped with no recorded cause: re-arming within the per-pull-request recovery budget",
    };
  return exitClass(ledger, exit, park, forge);
}

/** A stopped ledger's class by its exit, first match wins. */
function exitClass(
  ledger: Ledger,
  exit: number,
  park: ParkReading | undefined,
  forge: PrFacts,
): Classified {
  if (exit === DRIVE_EXIT.WORKTREE_UNCLEAN) return uncleanClass(ledger, forge);
  if (exit === DRIVE_EXIT.HITL_PARKED) return parkClass(park, forge);
  if (exit === DRIVE_EXIT.CONVERGED) return convergedClass(ledger, forge);
  if (exit === DRIVE_EXIT.PR_CONFLICTING) return conflictStopClass(forge);
  const failed = exit === FAILED ? failedConflictClass(forge) : null;
  return (
    failed ??
    mechanicalStopClass(ledger, exit, forge) ??
    EXITS[exit]?.(ledger) ?? {
      class: "needs-person",
      why: `stopped ${exit}: only a person settles it${conflictNote(forge.mergeable)} (see the drive's handoff)`,
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
  /** What this host shows of a silent ledger's driver. */
  presence: (pr: number, ledger: Ledger) => Promise<DriverPresence>;
}

/** Runs a forge read when the tick's pool has a place for it (`pool.ts`). */
export type Admit = <T>(read: () => Promise<T>) => Promise<T>;

/** A reading's reader of base branch heads: pull requests on one base share one read. */
function baseHeads(slug: string, admit: Admit): Reading["baseHead"] {
  const read = new Map<string, Promise<BaseHead>>();
  return (branch) => {
    if (branch === undefined || branch === "")
      return Promise.resolve({
        unreadable: "the forge reports no base branch for it",
      });
    const known = read.get(branch);
    if (known !== undefined) return known;
    const head = admit(() => branchHead(slug, branch)).then(
      (oid): BaseHead => ({ oid }),
      (error: unknown): BaseHead => ({ unreadable: failureText(error) }),
    );
    read.set(branch, head);
    return head;
  };
}

/** What the forge reports of a pull request beside its ledger, its base branch's head for a ledger whose stop a conflict re-drives. */
async function factsOf(
  pr: OpenPr,
  ledger: Ledger,
  r: Reading,
): Promise<PrFacts> {
  const facts = {
    head: pr.headRefOid ?? null,
    mergeable: pr.mergeable ?? null,
  };
  return readsBaseHead(ledger, facts.mergeable)
    ? { ...facts, base: await r.baseHead(pr.baseRefName) }
    : facts;
}

/** A stopped ledger's explicit request, preserving person stops and unanswered parks. */
function rearmRequest(
  ledger: Ledger,
  labels: LabelConfig | null,
  carried: string[] | undefined,
  classified: Classified,
): { classified: Classified; evidence: Evidence } {
  const eligible =
    ledger.driver.state === "stopped" &&
    ledger.driver.personStop === undefined &&
    ledger.driver.exit !== DRIVE_EXIT.MAILBOX_STOPPED &&
    ledger.driver.exit !== DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT;
  if (!eligible || labels === null || !hasCommand(labels, carried, "rearm"))
    return { classified, evidence: {} };
  const next =
    classified.class === "parked" || classified.class === "unplaced"
      ? classified
      : {
          class: "re-armable" as const,
          why: "a person's rearm request asks to restart this stopped drive in its existing tree",
        };
  return {
    classified: next,
    evidence: {
      rearm: true,
      rearmLabel: `${labels.prefix}rearm`,
      noCause: false,
      legacyNoCause: false,
    },
  };
}

/** What a silent ledger's evidence adds: whether this host shows its driver gone, and what it showed. */
async function presenceEvidence(
  pr: number,
  ledger: Ledger,
  classified: Classified,
  r: Reading,
): Promise<Evidence> {
  if (classified.class !== "silent") return {};
  const seen = await r.presence(pr, ledger);
  return { driverGone: seen.gone, driverCheck: seen.why };
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
  let classified = classifyLedger(ledger, nowMs, windowMs, park, forge);
  const request = rearmRequest(ledger, labels, pr.labels, classified);
  classified = request.classified;
  return {
    ...base,
    ...classified,
    evidence: {
      ...ledgerEvidence(ledger, nowMs, forge),
      ...request.evidence,
      ...(await presenceEvidence(pr.number, ledger, classified, r)),
    },
    ...waitingOf(classified, park, pr.author?.login),
  };
}

/** The unanswered decisions a parked ledger carries into its notification, its conflict's re-drive included. */
function waitingOf(
  classified: Classified,
  park: ParkReading | undefined,
  author?: string,
): { waiting?: WaitingPark[] } {
  if (
    (classified.class !== "parked" &&
      classified.stale?.conflictStop !== true) ||
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
  admit: Admit = (read) => read(),
): Promise<DrivenPr[]> {
  const reading: Reading = {
    slug,
    login,
    nowMs,
    windowMs: stallThresholdMs(),
    labels,
    adoption,
    baseHead: baseHeads(slug, admit),
    presence: driverPresence,
    ...(comments === undefined ? {} : { comments }),
  };
  const out: DrivenPr[] = [];
  for (const pr of prs) {
    const drive = await driveOf(pr, reading);
    if (drive !== null) out.push(drive);
  }
  return out;
}
