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
 * | stopped `CONVERGED` (`0`), the pull request conflicting with its base | stale, once per head and base head |
 * | stopped `CONVERGED`, mergeable with a head past the verified head | stale unless the dispatcher proves a clean base merge |
 * | stopped `CONVERGED`, clean base merge proved and new required checks pending | held from re-drive until the checks settle |
 * | stopped `PR_CONFLICTING` (`9`) | stale |
 * | stopped `CI_REPAIR_SPENT` (`21`) with diagnosis on the current head | needs-person, with the diagnosis |
 * | stopped `STALLED` (`14`), its stop recording that every stalled pass ended `PUSH_FAILED`, at the head its rounds were counted on | needs-person, with why the push failed |
 * | stopped `STALLED` (`14`), `CI_REPAIR_SPENT` without a diagnosis on the current head, `PASS_DEADLINE` (`15`) | stale, once per head commit |
 * | stopped `CI_INFRA_PERSISTED` (`23`) | stale, once per stop after a backoff (`infra-backoff.ts`); needs-person past its re-drives |
 * | stopped `CHECK_RUNS_UNREADABLE` (`25`) | stale, once per head commit, naming the pages read; a second such stop on the head is a person's, as a systematic read failure |
 * | stopped `FORGE_RATE_LIMITED` (`24`) | stale, once per stop from the forge limit's reset (`forge-limit-redrive.ts`) |
 * | stopped `INDETERMINATE` (`1`), the pull request conflicting with its base | stale, once per head and base head |
 * | stopped `CONVERGED` at the verified head and mergeable, `PR_NOT_OPEN` (`5`), `TAKEN_OVER` (`20`) | done |
 * | stopped with an explicit person's-stop record, `MAILBOX_STOPPED` (`18`), `MAILBOX_PAUSE_TIMEOUT` (`19`) | stopped-by-person |
 * | stopped with no exit and no person's-stop record | re-armable (stopped-unknown once its recovery budget is spent) |
 * | stopped `HITL_PARKED` (`8`), every parked item answered | re-armable |
 * | stopped `QUOTA_PARKED` (`16`), `NOT_SETTLED` (`4`) | re-armable |
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
 * that still merges cleanly leaves the converged drive waiting for a
 * person's merge. On apply, a stopped drive with a trusted announcement at
 * the prior head can refresh after a clean merge of its base. The check and
 * ledger write run without review rounds. Changed or unprovable history goes
 * through the ordinary stale re-drive.
 *
 * A ledger that stopped `PR_CONFLICTING` is read beside its pull request's
 * mergeability, its head and its base branch's head, which is read for no
 * other ledger. Its change is the pair of heads, whatever the forge reports
 * of its mergeability: still conflicting, the drive's conflict-resolve round
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
 * the base if repair succeeds, then the drive parks on unanswered questions.
 * A re-drive that leaves it parked or stopped `PR_CONFLICTING` at the same
 * pair hands it back to a person (`settleConflictStops`): a conflict the
 * drive could not resolve, such as two requirements that contradict each
 * other, is that person's decision too.
 *
 * A stall, an unreadable check-runs listing (`CHECK_RUNS_UNREADABLE`), or a
 * CI stop without a diagnosis on the current head, is eligible for recovery.
 * Its change is its head commit and its exit, so it is re-driven once for
 * each; once this machine or another host re-drove that change and the ledger
 * still stopped the same way, it is a person's (`settleConflictStops`). A
 * stall whose stop recorded work left in its tree, or never measured it (the
 * ledger's last `stop` event, `leftWork`), names that tree, where its
 * re-drive must run (`stall-tree.ts`). One whose head is not known is
 * `unplaced`; one whose passes all failed to push is a person's.
 *
 * A ledger that stopped `PASS_DEADLINE`, the driver having spent its
 * restarts from a pass killed at its deadline, is re-driven the same way,
 * once per head commit, by a fresh pass, in the tree it stopped in when its
 * stop measured work left there, since the killed passes' work stays there.
 * One that stopped `INDETERMINATE` (`1`) while its pull request conflicts
 * with its base is re-driven once per pair of its head and its base branch's
 * head, the change a stop on a conflict is keyed on, so the drive's
 * conflict-resolve round runs once for it; its base branch's head is read
 * for it, and while the forge still computes its mergeability it is
 * `unplaced`. Both re-drives draw on the pull request's recovery budget
 * (`recovery`, `no-cause-stops.ts`).
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
 * that stopped `PR_CONFLICTING` whose mergeability, head or base branch's
 * head is not known, since the change a re-drive would act on cannot be told.
 * Where a failed call stopped the read (its comments, a thread's answers,
 * its base branch's head), the drive carries that call's failure class,
 * which decides whether the tick waits it out (`read-failures.ts`); a read
 * that answered but does not parse carries none.
 *
 * Where the repository turns dispatch labels on, each drive carries its
 * pull request's labels, and a pull request with no ledger that carries the
 * `drive` command label is `unarmed`: a person asked for a drive, and the
 * plan arms one. So is one the repository's adoption rule adopts
 * (`dispatch.adopt`, `adopt.ts`), whatever the labels. No state label is
 * read here.
 */
import { stallThresholdMs } from "../../../skills/drive-pr/scripts/lib/doctor.ts";
import type {
  Ledger,
  LedgerSnapshot,
} from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { snapshotFromListing } from "../../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { diagnosisOutcome } from "../../../skills/drive-pr/scripts/lib/state/ci-actions.ts";
import { lastStopEvent } from "../../../skills/drive-pr/scripts/lib/state/events.ts";
import { ledgerTree } from "../stall-tree.ts";
import { exitClass as stopClass } from "../../../skills/drive-pr/scripts/lib/status/exit-classes.ts";
import { infraStopClass } from "../infra-backoff.ts";
import {
  reviewerFailureDisposition,
  reviewerFailurePolicy,
  type ReviewerFailurePolicy,
} from "../reviewer-failure.ts";
import { forgeLimitStopClass } from "../forge-limit-redrive.ts";
import { type DriverPresence, driverPresence } from "./silent-driver.ts";
import { type Adoption, type Author, idleForAdoption } from "../adopt.ts";
import type { PickupArms } from "../pickup-arms.ts";
import { unarmed } from "./ledger-arming.ts";
import { type Admit, type BaseHead, baseHeads, classed } from "./base-heads.ts";
export type { Admit } from "./base-heads.ts";
import { ended, passedBefore, type TickBound } from "./bounded.ts";
import { commandLabel, hasCommand, type LabelConfig } from "../labels.ts";
import {
  rearmableStop,
  classifyRearm,
  rearmBinding,
  type RearmStop,
} from "../rearm-binding.ts";
import type { Listing } from "../tick-comments.ts";
import { minutesBetween } from "../text.ts";
import { readPark, type ParkReading } from "./park-reading.ts";
import { failedRead } from "./ledger-read-failure.ts";
import { ledgerParks } from "../park-events.ts";
import { readFailureOf } from "../read-failures.ts";
import {
  listComments,
  listedFrom,
} from "../../../shared/records/forge-claims.ts";
import {
  announcementsOf,
  MERGE_READY,
} from "../../../skills/drive-pr/scripts/lib/announce.ts";
export type { ParkReading } from "./park-reading.ts";
import type {
  DrivenPr,
  Evidence,
  LedgerClass,
  StaleCause,
  WaitingPark,
} from "../types.ts";
import { parseMs } from "../../../shared/time.ts";
import { readsBaseHead, stopEvidence } from "./ledger-stop-evidence.ts";
import { readFacts } from "./ledger-facts.ts";
import { undecided } from "./ledger-undecided.ts";
import { pushFailedStallClass } from "./push-failed-stall.ts";
import {
  conflictNote,
  probeEvidence,
  rearmTree,
  withProbeReason,
} from "./ledger-probe.ts";

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
  /** For `unplaced`: the forge leaves the pull request's mergeability, head or base undecided, which a later tick reads again. */
  forgeUndecided?: true;
  /** For `stale`: what its stop does not fix. */
  stale?: StaleCause;
}

const short = (sha: string) => sha.slice(0, 7);

/** What a ledger is read beside when the forge said nothing of its pull request. */
const NO_FACTS: PrFacts = { head: null, mergeable: null };

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
  if ("unread" in facts)
    return verified === ""
      ? unplaced(
          `${facts.unread}, and its ledger names no head the drive verified`,
        )
      : { ...unplaced(facts.unread), forgeUndecided: true };
  const { head, conflicting } = facts;
  if (conflicting) {
    const pair = conflictPair(forge);
    if ("unread" in pair)
      return undecided(
        `stopped ${DRIVE_EXIT.CONVERGED} (converged), and now conflicting with its base, but ${pair.unread}, so the change a re-drive would act on cannot be told`,
      );
    return conflictRedrive(
      `stopped ${DRIVE_EXIT.CONVERGED} (converged), and now conflicting with its base`,
      pair,
    );
  }
  if (verified === "")
    return unplaced("its ledger names no head the drive verified");
  if (head === verified)
    return {
      class: "done",
      why: `stopped ${DRIVE_EXIT.CONVERGED} (converged), still at the verified head ${short(verified)} and mergeable`,
    };
  const cause = `head ${short(head)} past the verified head ${short(verified)}`;
  return {
    class: "stale",
    why: `stopped ${DRIVE_EXIT.CONVERGED} (converged), and now ${cause}: re-drive on any account`,
    stale: {
      cause,
      change: `head ${head}, mergeable`,
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
    return undecided(
      `stopped ${DRIVE_EXIT.PR_CONFLICTING} (conflicting with its base), and ${pair.unread}, so the change a re-drive would act on cannot be told`,
    );
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
    return undecided(
      `stopped ${FAILED}, and ${pair.unread}, so whether its conflict-resolve round settles it cannot be told`,
    );
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
  [
    DRIVE_EXIT.CI_INFRA_PERSISTED,
    {
      kind: "ci-infra",
      words: "CI still failing on the infrastructure through its re-runs",
    },
  ],
  [
    DRIVE_EXIT.CHECK_RUNS_UNREADABLE,
    {
      kind: "check-runs",
      words: "its head's check-runs listing could not be read whole",
    },
  ],
  [
    DRIVE_EXIT.FORGE_RATE_LIMITED,
    {
      kind: "forge-limit",
      words: "the forge's rate limit for its credential spent",
    },
  ],
]);

/** Why a `CI_REPAIR_SPENT` stop whose head was diagnosed is a person's, or `null`. */
function diagnosedStopWhy(
  ledger: Ledger,
  exit: number,
  head: string,
): string | null {
  const detail = diagnosisOutcome(ledger.ciActions ?? [], head);
  return detail === undefined
    ? null
    : `stopped ${exit} after escalating CI repair on head ${short(head)}: ${detail}`;
}

/** A `STALLED`, `CI_REPAIR_SPENT` or `PASS_DEADLINE` stop: `stale`, keyed on the pull request's head and the exit, `unplaced` while the head is unknown. */
function mechanicalStopClass(
  ledger: Ledger,
  exit: number,
  forge: PrFacts,
): Classified | null {
  const stop = MECHANICAL_STOPS.get(exit);
  if (stop === undefined) return null;
  const pushFailed = pushFailedStallClass(ledger, exit, forge);
  if (pushFailed !== null) return pushFailed;
  const head = forge.head;
  if (head === null || head === "")
    return {
      class: "unplaced",
      why: `stopped ${exit} (${stop.words}), and the forge reports no head commit for it, so the once-per-head re-drive cannot be kept`,
    };
  if (stop.kind === "ci-infra")
    return infraStopClass(ledger, exit, head, stop.words);
  const diagnosed =
    stop.kind === "ci-repair" ? diagnosedStopWhy(ledger, exit, head) : null;
  if (diagnosed !== null)
    return {
      class: "needs-person",
      why: `${diagnosed}${conflictNote(forge.mergeable)}`,
    };
  if (stop.kind === "forge-limit")
    return forgeLimitStopClass(ledger, exit, head, stop.words);
  const last = lastStopEvent(ledger.events ?? []);
  const tree = boundToTree(stop.kind, exit, last) ? ledgerTree(ledger) : null;
  const words =
    stop.kind === "check-runs" && Number.isSafeInteger(last?.listingPages)
      ? `${stop.words} after ${last?.listingPages} page(s)`
      : stop.words;
  return {
    class: "stale",
    why: `stopped ${exit} (${words}): re-drive ${rearmTree(tree, last?.leftWork)}, once for head ${short(head)}`,
    stale: {
      cause: `stopped ${exit}, ${words}`,
      change: `head ${head}, stopped ${exit}`,
      mechanicalStop: stop.kind,
      ...(stop.recovery === true ? { recovery: true as const } : {}),
      ...(tree === null ? {} : { tree }),
    },
  };
}

/**
 * Whether a mechanical stop's re-drive must run in the tree it stopped in: a
 * stall or listing stop that left work there or never measured it, and a pass
 * deadline whose stop measured work left. A deadline stop that never measured comes from a
 * driver that did not record it, so it re-drives on any account.
 */
function boundToTree(
  kind: NonNullable<StaleCause["mechanicalStop"]>,
  exit: number,
  last: ReturnType<typeof lastStopEvent>,
): boolean {
  const own = last === undefined || last.cause === String(exit);
  if (kind === "stall" || kind === "check-runs")
    return own && last?.leftWork !== false;
  return kind === "deadline" && own && last?.leftWork === true;
}

/** Why a stop the exit table (`exitClass`) places by its exit alone reads as its class, for the exits that say more than a person's stop. */
const EXIT_WHY: Record<number, (ledger: Ledger) => string> = {
  [DRIVE_EXIT.PR_NOT_OPEN]: () =>
    `stopped ${DRIVE_EXIT.PR_NOT_OPEN} (merged or closed)`,
  [DRIVE_EXIT.TAKEN_OVER]: () =>
    `stopped ${DRIVE_EXIT.TAKEN_OVER} (taken over by another clone)`,
  [DRIVE_EXIT.MAILBOX_STOPPED]: () =>
    `stopped ${DRIVE_EXIT.MAILBOX_STOPPED} (a mailbox stop): a person's stop is never re-armed`,
  [DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT]: () =>
    `stopped ${DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT} (a mailbox pause): a person's stop is never re-armed`,
  [DRIVE_EXIT.QUOTA_PARKED]: (ledger) =>
    `stopped ${DRIVE_EXIT.QUOTA_PARKED} (quota-parked; wall resets ${ledger.quotaPark?.resetAt ?? "at an unknown time"}): re-arm on an account other than the wall's, or after the reset`,
  [DRIVE_EXIT.NOT_SETTLED]: () =>
    `stopped ${DRIVE_EXIT.NOT_SETTLED} (not judgeable yet): re-arm on any account`,
  [DRIVE_EXIT.SINGLE_INSTANCE_LOCK]: () =>
    `stopped ${DRIVE_EXIT.SINGLE_INSTANCE_LOCK}: another driver holds it`,
  [DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE]: () =>
    `stopped ${DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE}: another driver holds it`,
  [DRIVE_EXIT.REVIEW_SKIPPED]: () =>
    `stopped ${DRIVE_EXIT.REVIEW_SKIPPED} (the reviewer skipped its head, and its review of an earlier head does not cover it): a re-arm waits for a review that will not come, so a person has the reviewer review the head or pushes a commit it reviews (see the drive's handoff)`,
};

function runningClass(
  ledger: Ledger,
  nowMs: number,
  windowMs: number,
): Classified {
  const beat = parseMs(ledger.driver.heartbeat);
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
  const disputes = park.disputed ?? [];
  const waiting = `waiting on ${park.waiting.join(", ")}${disputes.length === 0 ? "" : `; disputed answers to ${disputes.join(", ")}`}`;
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
    return undecided(
      `stopped ${DRIVE_EXIT.HITL_PARKED} (parked), ${waiting}, and conflicting with its base, but ${pair.unread}, so the change a re-drive would act on cannot be told`,
    );
  return conflictRedrive(
    `parked ${waiting}, and conflicting with its base`,
    pair,
  );
}

/** The evidence a report prints for one ledger. */
function ledgerEvidence(
  ledger: Ledger,
  nowMs: number,
  forge: PrFacts,
): Evidence {
  const beat = parseMs(ledger.driver.heartbeat);
  return {
    ...stopEvidence(
      ledger,
      forge,
      MECHANICAL_STOPS.has(ledger.driver.exit ?? Number.NaN),
    ),
    driverActor: ledger.driver.actor,
    driverClone: ledger.driver.clone,
    handoff: ledger.narrative.join("\n").slice(-12_000),
    generation: ledger.generation,
    round: ledger.round,
    phase: ledger.phase,
    driver: ledger.driver.state,
    exit: ledger.driver.exit ?? null,
    ...probeEvidence(ledger.driver),
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
  const placed = exitClass(ledger, exit, park, forge);
  return withProbeReason(
    placed,
    ledger.driver,
    exit,
    conflictNote(forge.mergeable),
  );
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
    mechanicalStopClass(ledger, exit, forge) ?? {
      class: stopClass(exit).class,
      why:
        EXIT_WHY[exit]?.(ledger) ??
        `stopped ${exit}: only a person settles it${conflictNote(forge.mergeable)} (see the drive's handoff)`,
    }
  );
}

export interface OpenPr {
  isCrossRepository?: boolean;
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
  /** Whether a check on its head fails, and its unresolved review threads: what says an automation pull request needs work. */
  failingChecks?: boolean;
  unresolvedThreads?: number;
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
  pickupArms?: PickupArms;
  slug: string;
  login: string | null;
  nowMs: number;
  windowMs: number;
  labels: LabelConfig | null;
  /** The repository's adoption rule, where on. */
  adoption: Adoption | null;
  /** The head of a base branch, read at most once per reading. */
  baseHead: (branch: string | undefined) => Promise<BaseHead>;
  /** A pull request's comments as the tick listed them, shared with the other records read from them, or as the forge lists them now. */
  comments: (pr: number) => Promise<Listing>;
  /** What this host shows of a silent ledger's driver. */
  presence: (pr: number, ledger: Ledger) => Promise<DriverPresence>;
  /** The tick's bound, where it has one: no park thread is read once it has ended. */
  bound?: TickBound;
  reviewerFailures: ReviewerFailurePolicy;
  cwd?: string;
  admit: Admit;
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

/** Evidence from a person's explicit request, where its label remains. */
function rearmRequest(
  pr: OpenPr,
  r: Reading,
  comments: readonly unknown[],
  stop: RearmStop | null,
): Evidence {
  if (
    r.labels === null ||
    (stop === null && !hasCommand(r.labels, pr.labels, "rearm"))
  )
    return {};
  const request = rearmBinding(
    { repo: r.slug, number: pr.number },
    r.login,
    comments,
    commandLabel(r.labels, "rearm"),
    stop,
  );
  if (hasCommand(r.labels, pr.labels, "rearm")) return request;
  return typeof request.rearmFailure === "string"
    ? {
        rearmFailure: request.rearmFailure,
        rearmRequestId: request.rearmRequestId ?? null,
      }
    : {};
}

/** A vanished ledger leaves a lapsed request, which the tick still retires. */
function noLedger(
  pr: OpenPr,
  base: Omit<DrivenPr, "class" | "why" | "evidence">,
  r: Reading,
  comments: readonly unknown[],
): DrivenPr | null {
  const drive = unarmed(pr, base, r);
  const request = rearmRequest(pr, r, comments, null);
  if (drive !== null)
    return { ...drive, evidence: { ...drive.evidence, ...request } };
  return typeof request.rearmExpired === "string"
    ? {
        ...base,
        class: "unplaced",
        why: request.rearmExpired,
        evidence: request,
      }
    : null;
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

/** Whether the tick's already-read comments show a merge-ready announcement for another head. */
function announcementEvidence(
  comments: readonly unknown[],
  slug: string,
  pr: number,
  login: string | null,
  head: string | null,
): Evidence {
  if (head === null) return {};
  const announcements = announcementsOf(
    listedFrom(MERGE_READY, comments, { repo: slug, number: pr }, login),
  );
  return announcements.some(
    (announcement) =>
      announcement.unreadable !== undefined || announcement.head !== head,
  )
    ? { staleMergeReadyAnnouncement: true }
    : {};
}

/** One pull request's drive; `null` when it carries no ledger and no label asks for one. */
async function driveOf(pr: OpenPr, r: Reading): Promise<DrivenPr | null> {
  const { slug, login, nowMs, windowMs, labels } = r;
  const base = baseOf(pr, labels);
  const listing = await r.comments(pr.number);
  if (!listing.ok)
    return {
      ...base,
      class: "unplaced",
      why: listing.failure.reason,
      evidence: {},
      readFailed: true,
      ...classed(readFailureOf(listing.failure)),
    };
  const snapshot = snapshotFromListing(listing.value, login);
  const why = unreadable(snapshot);
  if (why === "") return noLedger(pr, base, r, listing.value);
  if (why !== null || snapshot.canonical?.parsed.kind !== "ledger")
    return {
      ...base,
      class: "unplaced",
      why: why ?? "",
      evidence: {},
      readFailed: true,
    };
  const ledger = snapshot.canonical.parsed.ledger;
  const stop = rearmableStop(ledger)
    ? { comment: snapshot.canonical.comment.id, generation: ledger.generation }
    : null;
  const request = rearmRequest(pr, r, listing.value, stop);
  const park = await readPark(
    pr.number,
    ledger,
    slug,
    listing.value,
    {},
    r.bound,
    request.rearm === true,
  );
  const forge = await factsOf(pr, ledger, r);
  const reviewer = await r.admit(() =>
    reviewerFailureDisposition(
      slug,
      pr.number,
      ledger,
      forge.head,
      listing.value,
      r.reviewerFailures,
      pr.isDraft === true,
      r.cwd,
      r.bound,
    ),
  );
  const classified = classifyRearm(
    reviewer?.classified ??
      classifyLedger(ledger, nowMs, windowMs, park, forge),
    request,
  );
  return {
    ...base,
    ...classified,
    ...(ledger.driver.state === "running" ? { running: true as const } : {}),
    ...(classified.class === "unplaced" ? failedRead(ledger, park, forge) : {}),
    evidence: {
      ...ledgerEvidence(ledger, nowMs, forge),
      ...announcementEvidence(
        listing.value,
        slug,
        pr.number,
        login,
        forge.head,
      ),
      ...reviewer?.evidence,
      ...request,
      ...(await presenceEvidence(pr.number, ledger, classified, r)),
      ...idleForAdoption(pr, r.adoption, r.login),
    },
    ...waitingOf(classified, park, pr.author?.login),
    parks: ledgerParks(ledger),
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
 * from the forge where it does not, as a launch's fresh read does. Under
 * the tick's `bound`, no base branch's head and no driver's presence is
 * read once it has ended.
 */
export async function readDrives(
  slug: string,
  login: string | null,
  prs: readonly OpenPr[],
  nowMs: number,
  labels: LabelConfig | null = null,
  adoption: Adoption | null = null,
  options: {
    comments?: (pr: number) => Promise<Listing>;
    admit?: Admit;
    bound?: TickBound | undefined;
    pickupArms?: PickupArms | undefined;
    reviewer?: { policy?: ReviewerFailurePolicy; cwd: string } | undefined;
  } = {},
): Promise<DrivenPr[]> {
  const {
    comments,
    admit = (read) => read(),
    bound,
    pickupArms,
    reviewer,
  } = options;
  const reading: Reading = {
    slug,
    login,
    nowMs,
    windowMs: stallThresholdMs(),
    labels,
    adoption,
    ...(pickupArms === undefined ? {} : { pickupArms }),
    baseHead: baseHeads(slug, admit, bound),
    presence: (pr, ledger) =>
      ended(bound)
        ? Promise.resolve({
            gone: false,
            why: passedBefore("this host looked for its driver's run"),
          })
        : driverPresence(pr, ledger),
    comments: comments ?? ((pr) => listComments({ repo: slug, number: pr })),
    reviewerFailures: reviewer?.policy ?? reviewerFailurePolicy({}),
    ...(reviewer === undefined ? {} : { cwd: reviewer.cwd }),
    admit,
    ...(bound === undefined ? {} : { bound }),
  };
  const out: DrivenPr[] = [];
  for (const pr of prs) {
    const drive = await driveOf(pr, reading);
    if (drive !== null) out.push(drive);
  }
  return out;
}
