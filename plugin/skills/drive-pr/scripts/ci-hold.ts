#!/usr/bin/env bun
import { retryAttempts } from "../../../shared/retry.ts";

/**
 * Own the repository's temporary CI-hold label (`ci.hold_label`). The GitHub
 * timeline event id is the compare-and-set token: the drive removes only the
 * transition it recorded. The label is a CI cost setting, not a signal to the
 * drive, so a live label the drive holds no record of (one an earlier run
 * lost track of, a dead drive left, or anyone else added) is adopted
 * (`adopted`), never a reason to stop. A repository without a hold label has nothing to
 * own: `ensure`, `release` and `rollback` print `disabled` and succeed, and
 * `final-ready` proves the required checks on the exact head directly.
 *
 * Usage:
 *   ci-hold.ts ensure [PR] --expect-head SHA
 *   ci-hold.ts release [PR] --expect-head SHA [--expect-transition ID]
 *   ci-hold.ts rollback [PR] --expect-head SHA
 *   ci-hold.ts final-ready [PR] --expect-head SHA [--require-success]
 *
 * `--require-success` requires completed checks to succeed, for final-ready only.
 */

import {
  checkRunWatermark,
  ciHoldTransitions,
  completedHoldPrecondition,
  completedRequiredCi,
  type LabelTransition,
  mutationProven,
  ownsHeldTransition,
  type PrSnapshot,
  parsePrSnapshot,
  reportsConflict,
  requiredCiStartedAt,
  requirementsWithoutRun,
} from "./lib/ci-hold.ts";
import { type CiPolicy, ciPolicy, holdLabelPolicy } from "./lib/ci-policy.ts";
import { fail, isDigits, isGitSha, runMain } from "./lib/cli.ts";
import { timelineEvents } from "./lib/pr-timeline.ts";
import { ghCall, git, gitCallTimeoutSeconds, resolvePr } from "./lib/proc.ts";
import {
  assertRemoteMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs } from "./lib/state/lock.ts";
import {
  adopt,
  confirmLiveHold,
  checkRuns,
  headWatermark,
  readCiState,
  writeCiState,
} from "./lib/ci-hold-state.ts";
import { type CiHoldState, LEGACY_CI_HOLD_LABEL } from "./lib/state/schema.ts";
import {
  attributeStatuses,
  checkRunsFor,
  ciVerdictOf,
  commitStatusesFor,
  hasNonReviewerCi,
} from "./lib/status/evidence.ts";
import {
  rerunAwaitsResult,
  withoutRerunning,
  withoutSuperseded,
  workflowRunsBehind,
} from "./lib/status/workflow-runs.ts";

let policy: CiPolicy = {
  requiredChecks: [],
  requiredApps: new Map(),
  derived: false,
  holdLabel: null,
};

function holdLabel(): string {
  if (policy.holdLabel === null)
    fail(1, "ci-hold: no hold label is configured (ci.hold_label)");
  return policy.holdLabel;
}

function usage(): never {
  fail(
    2,
    "usage: ci-hold.ts ensure|release|rollback|final-ready [PR] --expect-head SHA",
  );
}

async function snapshot(pr: string): Promise<PrSnapshot | null> {
  const result = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (result.code !== 0) return null;
  try {
    return parsePrSnapshot(
      JSON.parse(result.stdout) as unknown,
      policy.holdLabel,
    );
  } catch {
    return null;
  }
}

async function viewer(): Promise<string | null> {
  const result = await ghCall(["api", "user", "-q", ".login"]);
  const login = result.code === 0 ? result.stdout.trim() : "";
  return login === "" ? null : login;
}

async function transitions(pr: string): Promise<LabelTransition[] | null> {
  const events = await timelineEvents(pr);
  return events === null ? null : ciHoldTransitions(events, holdLabel());
}

const latestOf = (values: readonly LabelTransition[]): LabelTransition | null =>
  values.at(-1) ?? null;

/** Where the transitions after `previousId` begin, or null when it is not in the timeline. */
function firstIndexAfter(
  values: readonly LabelTransition[],
  previousId: string | null,
): number | null {
  if (previousId === null) return 0;
  const index = values.findIndex((transition) => transition.id === previousId);
  return index < 0 ? null : index + 1;
}

function exactSuccessor(
  values: readonly LabelTransition[],
  previousId: string | null,
): LabelTransition | null {
  const start = firstIndexAfter(values, previousId);
  return start !== null && values.length === start + 1
    ? (values.at(-1) ?? null)
    : null;
}

function transitionsFollowing(
  values: readonly LabelTransition[],
  previousId: string | null,
): LabelTransition[] | null {
  const start = firstIndexAfter(values, previousId);
  return start === null ? null : values.slice(start);
}

type HeldState = Extract<CiHoldState, { phase: "held" }>;
type ReleasingState = Extract<CiHoldState, { phase: "releasing" }>;
type ReleasedState = Extract<CiHoldState, { phase: "released" }>;

/** The released record a removal transition proves. */
const releasedBy = (
  transition: LabelTransition,
  head: string,
  checkRunWatermark: number,
  source: ReleasedState["source"],
): ReleasedState => ({
  phase: "released",
  eventId: transition.id,
  head,
  actor: transition.actor,
  createdAt: transition.createdAt,
  checkRunWatermark,
  source,
});

const exactReleaseOf = (
  successor: LabelTransition,
  head: string,
  persisted: ReleasingState,
): ReleasedState =>
  releasedBy(
    successor,
    head,
    persisted.checkRunWatermark,
    successor.actor === persisted.actor ? "drive" : "external",
  );

/** The held record an interrupted release leaves standing while the label is still live. */
const heldAgain = (persisted: ReleasingState): HeldState => ({
  phase: "held",
  adopted: persisted.adopted === true,
  eventId: persisted.heldEventId,
  addedAtHead: persisted.addedAtHead,
  actor: persisted.heldActor,
  createdAt: persisted.heldCreatedAt,
  checkRunWatermark: persisted.checkRunWatermark,
});

type SettledRelease =
  | { outcome: "held"; persisted: HeldState }
  | { outcome: "released" | "adopt" | "invisible" };

/**
 * What the live label and the newest transition say about an interrupted
 * release that no exact successor explains: the hold still stands, a removal
 * we cannot attribute to this drive proves an external release (persisted so
 * fresh full CI can authorize another hold), another transition followed and
 * the live label is adopted by the caller, or the timeline has not caught up.
 */
async function settleInterruptedRelease(
  pr: string,
  persisted: ReleasingState,
  live: NonNullable<Awaited<ReturnType<typeof snapshot>>>,
  latest: LabelTransition | null,
  head: string,
  sameHead: boolean,
): Promise<SettledRelease> {
  if (live.held && sameHead && latest?.id === persisted.heldEventId) {
    const held = heldAgain(persisted);
    await writeCiState(pr, held);
    return { outcome: "held", persisted: held };
  }
  if (!live.held && latest?.event === "unlabeled") {
    await writeCiState(
      pr,
      releasedBy(latest, head, persisted.checkRunWatermark, "external"),
    );
    return { outcome: "released" };
  }
  return { outcome: live.held ? "adopt" : "invisible" };
}

/** The authenticated actor and the live state just before a label mutation. */
async function readBeforeMutation(pr: string) {
  const login = await viewer();
  if (login === null)
    fail(1, "ci-hold: cannot identify the authenticated GitHub actor");
  return {
    login,
    live: await snapshot(pr),
    timeline: await transitions(pr),
  };
}

async function transitionAfter(
  pr: string,
  beforeId: string,
  event: "labeled" | "unlabeled",
  actor: string,
): Promise<{ event: LabelTransition; intervening: boolean } | null> {
  // GitHub's timeline can trail the label mutation briefly. Bound the retry;
  // an unobserved event is not ownership and must never be persisted as one.
  for await (const attempt of retryAttempts({
    attempts: 4,
    baseMs: 2_000,
    maxMs: 2_000,
    random: () => 1,
  })) {
    void attempt;
    const all = await transitions(pr);
    if (all === null) return null;
    const beforeIndex =
      beforeId === "" ? -1 : all.findIndex((item) => item.id === beforeId);
    if (beforeId !== "" && beforeIndex < 0) return null;
    const after = all.slice(beforeIndex + 1);
    const observed = after.at(-1);
    if (observed?.event === event && observed.actor === actor) {
      return { event: observed, intervening: after.length !== 1 };
    }
  }
  return null;
}

/** The label transition a recorded hold names, if its phase names one. */
function recordedTransitionId(recorded: CiHoldState | null): string | null {
  if (recorded === null) return null;
  if (recorded.phase === "acquiring") return recorded.previousEventId;
  if (recorded.phase === "releasing") return recorded.heldEventId;
  return recorded.eventId;
}

/**
 * The recorded hold must be a transition of the configured label. A
 * renamed `ci.hold_label` would otherwise read the new label's empty
 * timeline, acquire it, and overwrite the record that authorizes removing
 * the old one. An interrupted first acquisition names no transition, so it
 * is matched on the label it recorded; one recorded before the label was
 * configurable added `LEGACY_CI_HOLD_LABEL`.
 */
async function assertRecordedHoldMatchesLabel(pr: string): Promise<void> {
  const recorded = await readCiState(pr);
  const recordedId = recordedTransitionId(recorded);
  if (recorded === null) return;
  const renamed = `if ci.hold_label was renamed, configure the label it was recorded under until this drive converges and releases it`;
  if (recorded.phase === "acquiring") {
    const label = recorded.label ?? LEGACY_CI_HOLD_LABEL;
    if (label !== holdLabel())
      fail(
        1,
        `ci-hold: the CI hold acquisition recorded for this PR adds '${label}', not '${holdLabel()}'; ${renamed}`,
      );
  }
  if (recordedId === null) return;
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  if (!timeline.some((transition) => transition.id === recordedId))
    fail(
      1,
      `ci-hold: the CI hold recorded for this PR is not a '${holdLabel()}' transition; ${renamed}`,
    );
}

async function ensure(pr: string, expectedPushHead: string): Promise<number> {
  const local = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (local.code !== 0 || local.stdout.trim() !== expectedPushHead) {
    console.error(
      `ci-hold: local HEAD is ${local.stdout.trim() || "<unreadable>"}, not expected push head ${expectedPushHead}`,
    );
    return 4;
  }
  const live = await snapshot(pr);
  if (live === null) fail(1, "ci-hold: cannot read the PR state");
  if (live.state !== "OPEN") return 5;
  const head = live.head;
  if (!isGitSha(head)) fail(1, "ci-hold: PR head is unreadable");
  let persisted = await readCiState(pr);
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  const latest = latestOf(timeline);

  if (persisted?.phase === "releasing") {
    const successor = exactSuccessor(timeline, persisted.heldEventId);
    if (!live.held && successor?.event === "unlabeled") {
      await writeCiState(pr, exactReleaseOf(successor, head, persisted));
      console.error(
        "ci-hold: recovered an interrupted completed release; waiting for its full CI before another hold can be acquired",
      );
      return 4;
    }
    const settled = await settleInterruptedRelease(
      pr,
      persisted,
      live,
      latest,
      head,
      true,
    );
    if (settled.outcome === "released") {
      console.error(
        "ci-hold: recovered an interrupted release with intervening transitions; waiting for fresh full CI",
      );
      return 4;
    }
    if (settled.outcome === "invisible") {
      console.error(
        "ci-hold: interrupted release is not visible in the timeline yet; retrying later",
      );
      return 4;
    }
    persisted = settled.outcome === "held" ? settled.persisted : null;
  }

  if (persisted?.phase === "acquiring") {
    const afterIntent = transitionsFollowing(
      timeline,
      persisted.previousEventId,
    );
    const successor = afterIntent?.length === 1 ? afterIntent[0] : null;
    if (
      live.held &&
      successor?.event === "labeled" &&
      successor.actor === persisted.actor
    ) {
      await writeCiState(pr, {
        phase: "held",
        eventId: successor.id,
        addedAtHead: persisted.head,
        actor: successor.actor,
        createdAt: successor.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
      });
      process.stdout.write("owned\n");
      return 0;
    }
    if (!live.held && (latest?.id ?? null) === persisted.previousEventId) {
      // The process stopped after recording intent but before GitHub applied
      // the mutation. Clearing and retrying under the same remote fence is
      // safe because the timeline proves nothing intervened.
      await writeCiState(pr, null);
      persisted = null;
    } else if (
      !live.held &&
      latest?.event === "unlabeled" &&
      (afterIntent?.length ?? 0) > 0
    ) {
      // Our add may have landed before another actor removed it. Ownership
      // is no longer attributable, but treating the newest removal as an
      // external release avoids a permanent refusal: all required checks
      // must start after this event before ensure may acquire again.
      await writeCiState(
        pr,
        releasedBy(latest, head, persisted.checkRunWatermark, "external"),
      );
      console.error(
        "ci-hold: recovered an interrupted acquisition followed by an external removal; waiting for fresh full CI",
      );
      return 4;
    } else if (
      afterIntent === null ||
      afterIntent.length > 0 ||
      (!live.held && successor === null)
    ) {
      // Ownership of the interrupted acquisition cannot be proven: drop the
      // record, so a live label is adopted below and an absent one acquired.
      await writeCiState(pr, null);
      persisted = null;
    } else {
      console.error(
        `ci-hold: interrupted label acquisition is not visible in the timeline yet; retrying later`,
      );
      return 4;
    }
  }

  if (live.held)
    return await confirmLiveHold(pr, head, persisted, latest, holdLabel());

  if (
    latest?.event === "unlabeled" &&
    !(
      persisted?.phase === "released" &&
      persisted.head === head &&
      persisted.eventId === latest.id
    )
  ) {
    // An absent label plus its newest removal is sufficient to establish an
    // external-release certificate even when no local ownership survived.
    // CAS ownership is needed to REMOVE a live label, not to acknowledge an
    // already-absent one. Requiring every check to start after this event is
    // the conservative path back to acquisition.
    persisted = {
      phase: "released",
      eventId: latest.id,
      head,
      actor: latest.actor,
      createdAt: latest.createdAt,
      checkRunWatermark:
        persisted?.phase === "held" ? persisted.checkRunWatermark : 0,
      source: "external",
    };
    await writeCiState(pr, persisted);
  }

  const runs = await checkRuns(head);
  if (runs === null) fail(1, "ci-hold: cannot read check-runs");
  const watermark =
    persisted?.phase === "released" &&
    persisted.head === head &&
    persisted.eventId === latest?.id
      ? persisted.checkRunWatermark
      : 0;
  const observed = completedHoldPrecondition(
    runs,
    policy.requiredChecks,
    head,
    latest,
    watermark,
    persisted?.phase === "released" && persisted.source === "external",
  );
  // GitHub runs no `pull_request` workflow while the PR conflicts with its
  // base, so these checks cannot complete until a push clears the conflict.
  // That push goes ahead unheld, and its head runs full CI.
  if (
    !observed &&
    reportsConflict(await ghCall(["pr", "view", pr, "--json", "mergeable"]))
  ) {
    console.error("ci-hold: the PR conflicts with its base; pushing unheld");
    process.stdout.write("conflicting\n");
    return 0;
  }
  if (!observed) {
    console.error(
      latest?.event === "unlabeled"
        ? "ci-hold: the required checks triggered by the latest unlabel have not completed on this head; refusing to re-add the hold yet"
        : "ci-hold: the initial required checks have not completed on this head; waiting before suppressing intermediate CI",
    );
    return 4;
  }
  // Refresh immediately before the mutation while the PR-wide mutation fence
  // is held. A same-login human action through another client remains an API
  // limitation; any observable intervening transition is refused below.
  const {
    login,
    live: beforeLive,
    timeline: beforeTimeline,
  } = await readBeforeMutation(pr);
  if (
    beforeLive === null ||
    beforeTimeline === null ||
    beforeLive.state !== "OPEN" ||
    beforeLive.head !== head ||
    beforeLive.held ||
    latestOf(beforeTimeline)?.id !== latest?.id
  )
    return 4;
  const beforeId = latestOf(beforeTimeline)?.id ?? "";
  const preHoldWatermark = checkRunWatermark(runs, head);
  if (preHoldWatermark === null)
    fail(1, "ci-hold: cannot establish the pre-hold check-run watermark");
  await writeCiState(pr, {
    phase: "acquiring",
    previousEventId: beforeId === "" ? null : beforeId,
    label: holdLabel(),
    head,
    actor: login,
    createdAt: new Date().toISOString(),
    checkRunWatermark: preHoldWatermark,
  });
  const add = await ghCall(["pr", "edit", pr, "--add-label", holdLabel()]);
  const mutation = await transitionAfter(pr, beforeId, "labeled", login);
  const confirmed = await snapshot(pr);
  if (mutation?.intervening === true) {
    await writeCiState(pr, null);
    console.error(
      `ci-hold: another '${holdLabel()}' transition raced label acquisition; leaving the live label untouched and refusing ownership`,
    );
    return 4;
  }
  if (
    !mutationProven(
      add.code,
      mutation?.event ?? null,
      confirmed !== null &&
        confirmed.state === "OPEN" &&
        confirmed.head === head &&
        confirmed.held &&
        mutation?.intervening === false,
    )
  ) {
    fail(
      1,
      `ci-hold: add-label exited ${add.code}, and the mutation could not be proven on the unchanged open head; refusing to record or later remove it`,
    );
  }
  if (mutation === null) fail(1, "ci-hold: labelled transition disappeared");
  await writeCiState(pr, {
    phase: "held",
    eventId: mutation.event.id,
    addedAtHead: head,
    actor: mutation.event.actor,
    createdAt: mutation.event.createdAt,
    checkRunWatermark: preHoldWatermark,
  });
  process.stdout.write("added\n");
  return 0;
}

async function release(
  pr: string,
  head: string,
  expectedTransition?: string,
): Promise<number> {
  let persisted = await readCiState(pr);
  const live = await snapshot(pr);
  if (live === null) fail(1, "ci-hold: cannot read the PR state");
  if (live.state !== "OPEN") return 5;
  if (live.head !== head) return 4;
  const initialTimeline = await transitions(pr);
  if (initialTimeline === null)
    fail(1, "ci-hold: cannot read the label timeline");
  const latest = latestOf(initialTimeline);
  if (
    expectedTransition !== undefined &&
    (!live.held ||
      latest?.event !== "labeled" ||
      latest.id !== expectedTransition)
  ) {
    console.error(
      "ci-hold: diagnosed CI hold transition changed; diagnose again before releasing",
    );
    return 4;
  }

  if (persisted?.phase === "releasing") {
    const successor = exactSuccessor(initialTimeline, persisted.heldEventId);
    if (
      !live.held &&
      persisted.head === head &&
      successor?.event === "unlabeled"
    ) {
      await writeCiState(pr, exactReleaseOf(successor, head, persisted));
      process.stdout.write("removed\n");
      return 0;
    }
    const settled = await settleInterruptedRelease(
      pr,
      persisted,
      live,
      latest,
      head,
      persisted.head === head,
    );
    if (settled.outcome === "released") {
      process.stdout.write("absent\n");
      return 0;
    }
    if (settled.outcome === "invisible") {
      console.error(
        `ci-hold: interrupted label release is not visible in the timeline yet; retrying later`,
      );
      return 4;
    }
    persisted = settled.outcome === "held" ? settled.persisted : null;
  }

  if (!live.held) {
    if (
      persisted?.phase === "released" &&
      persisted.head === head &&
      persisted.eventId === latest?.id
    ) {
      process.stdout.write("released\n");
      return 0;
    }
    if (latest?.event === "unlabeled") {
      // The absent label and newest removal establish an external release
      // even if local ownership was lost or never existed. No pre-event
      // watermark is available, so every required check must start after it.
      await writeCiState(pr, releasedBy(latest, head, 0, "external"));
      process.stdout.write("absent\n");
      return 0;
    }
    await writeCiState(pr, null);
    process.stdout.write("absent\n");
    return 0;
  }

  if (!ownsHeldTransition(persisted, latest)) {
    persisted = await adopt(pr, head, latest, holdLabel());
    if (persisted === null) {
      await writeCiState(pr, null);
      console.error(
        `ci-hold: '${holdLabel()}' is present but the timeline does not show it being added yet; retrying later`,
      );
      return 4;
    }
  }
  if (persisted === null || persisted.phase !== "held") return 4;

  const {
    login,
    live: beforeLive,
    timeline: beforeTimeline,
  } = await readBeforeMutation(pr);
  if (
    beforeLive === null ||
    beforeTimeline === null ||
    beforeLive.state !== "OPEN" ||
    beforeLive.head !== head ||
    !beforeLive.held ||
    (expectedTransition !== undefined &&
      latestOf(beforeTimeline)?.id !== expectedTransition) ||
    !ownsHeldTransition(persisted, latestOf(beforeTimeline))
  )
    return 4;
  const watermark = await headWatermark(head, "before the unlabel");
  if (watermark === null) {
    console.error(
      "ci-hold: no check run is registered on this head yet; retrying later",
    );
    return 4;
  }
  await writeCiState(pr, {
    phase: "releasing",
    adopted: persisted.adopted === true,
    heldEventId: persisted.eventId,
    addedAtHead: persisted.addedAtHead,
    heldActor: persisted.actor,
    heldCreatedAt: persisted.createdAt,
    head,
    actor: login,
    createdAt: new Date().toISOString(),
    checkRunWatermark: watermark,
  });
  const remove = await ghCall([
    "pr",
    "edit",
    pr,
    "--remove-label",
    holdLabel(),
  ]);
  const mutation = await transitionAfter(
    pr,
    persisted.eventId,
    "unlabeled",
    login,
  );
  const confirmed = await snapshot(pr);
  if (mutation?.intervening === true) {
    if (
      confirmed?.state === "OPEN" &&
      confirmed.head === head &&
      confirmed.held === false
    ) {
      const restoreBefore = await transitions(pr);
      const restoreBeforeId = latestOf(restoreBefore ?? [])?.id ?? "";
      const restore = await ghCall([
        "pr",
        "edit",
        pr,
        "--add-label",
        holdLabel(),
      ]);
      const restoreMutation =
        restoreBefore === null
          ? null
          : await transitionAfter(pr, restoreBeforeId, "labeled", login);
      const restored = await snapshot(pr);
      const restoreProven = mutationProven(
        restore.code,
        restoreMutation?.event ?? null,
        restored !== null &&
          restored.state === "OPEN" &&
          restored.head === head &&
          restored.held &&
          restoreMutation?.intervening === false,
      );
      // The original event is no longer newest regardless of whether our
      // best-effort restoration can be proven. Erase ownership before any
      // refusal so a restart never removes the replacement label.
      await writeCiState(pr, null);
      if (!restoreProven) {
        fail(
          1,
          `ci-hold: ownership changed during removal; add-label exited ${restore.code} and restoration could not be proven from the timeline and live label, so reconcile '${holdLabel()}' manually`,
        );
      }
    } else {
      await writeCiState(pr, null);
    }
    console.error(
      `ci-hold: ownership changed during removal; preserved the live label state and refused the release`,
    );
    return 4;
  }
  if (
    !mutationProven(
      remove.code,
      mutation?.event ?? null,
      confirmed !== null &&
        confirmed.state === "OPEN" &&
        confirmed.head === head &&
        !confirmed.held &&
        mutation?.intervening === false,
    )
  ) {
    fail(
      1,
      `ci-hold: remove-label exited ${remove.code}, and the unlabeled transition could not be proven on the unchanged open head`,
    );
  }
  if (mutation === null) fail(1, "ci-hold: unlabeled transition disappeared");
  await writeCiState(pr, {
    phase: "released",
    eventId: mutation.event.id,
    head,
    actor: mutation.event.actor,
    createdAt: mutation.event.createdAt,
    checkRunWatermark: watermark,
    source: "drive",
  });
  process.stdout.write("removed\n");
  return 0;
}

/**
 * `requireSuccess` is opt-in, not the default, because this proof has two
 * callers with different needs for the same "not yet ready" exit code:
 *
 * - `drive.ts` treats exit 4 as "still pending — sleep and retry", and
 *   separately re-derives the actual green/red verdict from
 *   `drive-status.ts`'s own `.ci` field once this returns 0. It never asks
 *   this function to distinguish "not fresh yet" from "fresh but failed" —
 *   doing so anyway made a genuinely failed required check indistinguishable
 *   from a still-catching-up one, so the driver retried forever instead of
 *   ever reaching its own red-CI detection (measured: `drive.ts loop
 *   control > stops for /fix-ci when the … witness completed red` timed out
 *   at 30s instead of exiting).
 * - `announce-merge-ready.ts` calls this repeatedly across one run as its
 *   ONLY re-confirmation that CI is still trustworthy — unlike `drive.ts`,
 *   it has no separate green/red re-check at each of those call sites (only
 *   a single aggregate-status snapshot taken once, up front). A required
 *   check rerun and failed after that snapshot but before a later
 *   confirmation was therefore invisible to it — passing
 *   `requireSuccess: true` is what closes that race for
 *   this caller specifically, without changing what exit 4 means for the
 *   other one.
 */
/** Re-read all CI evidence for both the initial proof and final verification. */
async function finalCiProofGreen(
  head: string,
  persisted: Extract<CiHoldState, { phase: "released" }> | null,
  requireSuccess: boolean,
): Promise<{ ok: true; startedAt: string | null } | { ok: false }> {
  const allRuns = await checkRuns(head);
  if (allRuns === null) return { ok: false };
  // A cancelled run another run replaced proves nothing about a required
  // check, however its check-run ids interleave with the replacement's.
  const workflowRuns = await workflowRunsBehind(
    "{owner}",
    "{repo}",
    head,
    allRuns,
  );
  // A run being re-run has its failed jobs replaced: they witness nothing.
  const settled = withoutSuperseded(allRuns, workflowRuns);
  // A newer skip looked at nothing, so it cannot stand in for the rerun that
  // is still outstanding.
  if (rerunAwaitsResult(settled, workflowRuns)) return { ok: false };
  const runs = withoutRerunning(settled, workflowRuns);
  const required = policy.requiredChecks;
  const apps = policy.requiredApps;
  const noHold = policy.holdLabel === null;
  // A required context with no check run on the head may be a legacy commit
  // status; read them only then, and never against an unlabel floor.
  const withoutRun =
    persisted === null
      ? requirementsWithoutRun(runs, required, head, apps)
      : [];
  const read =
    withoutRun.length > 0
      ? await commitStatusesFor("{owner}", "{repo}", head)
      : [];
  if (read === null) return { ok: false };
  const statuses = await attributeStatuses(
    "{owner}",
    "{repo}",
    head,
    read,
    withoutRun.flatMap((r) => (r.appId === undefined ? [] : [r.context])),
  );
  if (statuses === null) return { ok: false };
  const requiredFresh =
    persisted === null
      ? completedRequiredCi(
          runs,
          required,
          head,
          undefined,
          requireSuccess,
          0,
          false,
          noHold,
          { apps, statuses },
        )
      : completedRequiredCi(
          runs,
          required,
          head,
          persisted.createdAt,
          requireSuccess,
          persisted.checkRunWatermark,
          persisted.source === "external",
          false,
          { apps },
        );
  if (!requiredFresh) return { ok: false };
  if (requireSuccess && !(await requiredCiAggregateIsGreen(head)))
    return { ok: false };
  // Branch protection names no check: the overall verdict decides, and it
  // reads green before any workflow has registered on the head.
  if (required.length === 0 && policy.derived && !(await anyCiOnHead(head)))
    return { ok: false };
  return {
    ok: true,
    startedAt: requiredCiStartedAt(runs, required, head, apps),
  };
}

/** Strict success requires both check runs and attributed legacy statuses to be green. */
async function requiredCiAggregateIsGreen(head: string): Promise<boolean> {
  const [allRuns, statuses] = await Promise.all([
    checkRunsFor("{owner}", "{repo}", head),
    commitStatusesFor("{owner}", "{repo}", head),
  ]);
  if (allRuns === null || statuses === null) return false;
  const workflowRuns = await workflowRunsBehind(
    "{owner}",
    "{repo}",
    head,
    allRuns,
  );
  return ciVerdictOf(allRuns, statuses, false, head, workflowRuns) === "green";
}

/** Has any non-reviewer check run or commit status registered on `head`? */
async function anyCiOnHead(head: string): Promise<boolean> {
  const [allRuns, statuses] = await Promise.all([
    checkRunsFor("{owner}", "{repo}", head),
    commitStatusesFor("{owner}", "{repo}", head),
  ]);
  return (
    allRuns !== null && statuses !== null && hasNonReviewerCi(allRuns, statuses)
  );
}

/**
 * Re-proves CI green AND re-snapshots state, exact head, hold label, and the
 * label timeline right before `finalReady` commits to returning success —
 * closing (not just narrowing to the entry read) the window every earlier
 * read in this call spends on the network. A push or label re-add landing
 * in that window is otherwise invisible: this function only ever
 * snapshotted the PR once, at entry, unlike `set-verified` (drive-state.ts),
 * which already re-verifies before its own commit for the identical reason.
 *
 * The CI proof runs FIRST, the PR/timeline snapshot LAST — the opposite order
 * an earlier version used. `finalReady`'s caller cares most about exactly ONE
 * fact staying current at the instant this returns: whether `head` is genuinely
 * still the PR's head, unheld. Checking that LAST, after the CI proof's own
 * remote reads have already happened, shrinks the residual race to that one
 * final read's own round-trip — the same "nothing may follow the last read"
 * reasoning other fail-closed checks in this codebase already apply.
 *
 * `expectation` selects which timeline shape the caller's branch requires —
 * `emptyTimeline` for "no hold was ever applied", the persisted event id
 * otherwise, and `null` for a repository without a hold label, whose
 * timeline is never read.
 */
async function stillCurrentForFinalReady(
  pr: string,
  head: string,
  persisted: Extract<CiHoldState, { phase: "released" }> | null,
  expectation: { emptyTimeline: true } | { latestTransitionId: string } | null,
  requireSuccess: boolean,
): Promise<boolean> {
  if (requireSuccess) {
    const proof = await finalCiProofGreen(head, persisted, true);
    if (!proof.ok) return false;
  }
  // Timeline BEFORE head/state/held — putting the CI proof first and this
  // snapshot last is not enough if `snapshot()` (the head check) still runs
  // BEFORE `transitions()`: the head check is then not the temporally last
  // remote read, and a push landing in the window `transitions()` spends on the
  // network is invisible (head identity is exactly the one fact this function
  // exists to keep fresh). No further reordering closes the gap completely:
  // GitHub's REST API has no compare-and-swap, so SOME read is always last and
  // a mutation landing in ITS OWN round-trip stays unobservable — the
  // identical, explicitly accepted residual `drive-state.ts`'s own
  // `stillFullyCurrent()`/post-write check documents for the same reason. This
  // ordering puts that irreducible tail on the one fact worth protecting most.
  if (expectation !== null) {
    const finalTimeline = await transitions(pr);
    if (finalTimeline === null) return false;
    const timelineMatches =
      "emptyTimeline" in expectation
        ? finalTimeline.length === 0
        : latestOf(finalTimeline)?.id === expectation.latestTransitionId;
    if (!timelineMatches) return false;
  }
  const finalLive = await snapshot(pr);
  return (
    finalLive !== null &&
    finalLive.state === "OPEN" &&
    finalLive.head === head &&
    !finalLive.held
  );
}

async function finalReady(
  pr: string,
  head: string,
  requireSuccess = false,
): Promise<number> {
  const live = await snapshot(pr);
  if (live === null) fail(1, "ci-hold: cannot read the PR state");
  if (live.state !== "OPEN") return 5;
  if (live.head !== head || live.held) return 4;
  if (policy.holdLabel === null) {
    // No hold exists: every push ran full CI, so the required checks on this
    // exact head are the witness.
    const proof = await finalCiProofGreen(head, null, requireSuccess);
    if (!proof.ok) return 4;
    if (
      !(await stillCurrentForFinalReady(pr, head, null, null, requireSuccess))
    )
      return 4;
    process.stdout.write(`${proof.startedAt ?? ""}\n`);
    return 0;
  }
  const persisted = await readCiState(pr);
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  if (persisted === null) {
    if (timeline.length !== 0) return 4;
    // No intermediate hold was ever applied: the PR-open run of the required
    // checks is the full-CI witness for this exact head.
    const initialProof = await finalCiProofGreen(head, null, requireSuccess);
    if (!initialProof.ok) return 4;
    if (
      !(await stillCurrentForFinalReady(
        pr,
        head,
        null,
        { emptyTimeline: true },
        requireSuccess,
      ))
    )
      return 4;
    process.stdout.write(`${initialProof.startedAt ?? ""}\n`);
    return 0;
  }
  if (persisted.phase !== "released" || persisted.head !== head) return 4;
  if (latestOf(timeline)?.id !== persisted.eventId) return 4;
  const initialProof = await finalCiProofGreen(head, persisted, requireSuccess);
  if (!initialProof.ok) return 4;
  if (
    !(await stillCurrentForFinalReady(
      pr,
      head,
      persisted,
      { latestTransitionId: persisted.eventId },
      requireSuccess,
    ))
  )
    return 4;
  process.stdout.write(`${persisted.createdAt}\n`);
  return 0;
}

async function rollback(pr: string, expectedPushHead: string): Promise<number> {
  const persisted = await readCiState(pr);
  const live = await snapshot(pr);
  if (live === null) fail(1, "ci-hold: cannot read the PR state");
  if (live.state !== "OPEN") return 5;
  // A nonzero push can be a lost response after the ref update. Never remove
  // the hold when the expected pushed head is already live: the intermediate
  // synchronize run must stay suppressed until the normal convergence path.
  if (live.head === expectedPushHead) return 4;
  if (
    persisted?.phase !== "held" ||
    persisted.adopted === true ||
    live.head !== persisted.addedAtHead ||
    !live.held
  )
    return 4;
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  if (!ownsHeldTransition(persisted, latestOf(timeline))) return 4;
  return release(pr, live.head);
}

function takeExpectedTransition(
  command: string,
  argv: string[],
): string | undefined {
  const index = argv.indexOf("--expect-transition");
  if (index < 0) return undefined;
  const id = argv[index + 1];
  if (
    command !== "release" ||
    id === undefined ||
    !/^[A-Za-z0-9_+/=-]+$/.test(id)
  )
    usage();
  argv.splice(index, 2);
  return id;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv.shift() ?? "";
  if (!["ensure", "release", "rollback", "final-ready"].includes(command))
    usage();
  let pr = "";
  let head = "";
  let requireSuccess = false;
  const expectedTransition = takeExpectedTransition(command, argv);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === "--expect-head") head = argv[++index] ?? "";
    else if (value === "--require-success" && command === "final-ready")
      requireSuccess = true;
    else if (value.startsWith("--")) usage();
    else if (pr === "") pr = value;
    else usage();
  }
  pr = await resolvePr(pr);
  if (!isDigits(pr) || !isGitSha(head)) usage();
  const configError = (error: unknown): never =>
    fail(
      1,
      `ci-hold: ${error instanceof Error ? error.message : String(error)}`,
    );
  let holdLabel: string | null = null;
  try {
    holdLabel = holdLabelPolicy();
  } catch (error) {
    configError(error);
  }
  if (holdLabel === null) {
    // A hold an earlier drive recorded under a configuration that had one
    // may still own a live label: refusing beats leaving it on a PR whose
    // workflows keep skipping their jobs.
    const recorded = await readCiState(pr);
    if (recorded !== null && recorded.phase !== "released")
      fail(
        1,
        "ci-hold: this PR has a CI hold label recorded by an earlier drive, but ci.hold_label is not configured; configure ci.hold_label (and ci.required_checks) again with the label that drive used, 'ci:hold' before release 0.5.0, so that the drive can release it",
      );
    if (command !== "final-ready") {
      // No hold label: intermediate pushes run normal CI and there is no
      // label to acquire, release or roll back.
      process.stdout.write("disabled\n");
      return 0;
    }
  }
  try {
    policy = await ciPolicy(pr);
  } catch (error) {
    configError(error);
  }
  if (policy.holdLabel !== null) await assertRecordedHoldMatchesLabel(pr);
  if (command === "ensure" || command === "release" || command === "rollback") {
    const fence = await resolveFenceContext("ci-hold.ts");
    const remoteLock =
      fence === null
        ? null
        : await assertRemoteMutationAllowed(fence, pr, "ci-hold.ts");
    const heartbeat =
      remoteLock === null
        ? null
        : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
    try {
      if (command === "ensure") return await ensure(pr, head);
      if (command === "rollback") return await rollback(pr, head);
      return await release(pr, head, expectedTransition);
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
      remoteLock?.release();
      remoteLock?.dispose();
    }
  }
  return finalReady(pr, head, requireSuccess);
}

runMain("ci-hold.ts", main);
