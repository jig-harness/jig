#!/usr/bin/env bun

/**
 * Own the temporary `ci:hold` label without ever deleting another actor's
 * transition. The GitHub timeline event id is the compare-and-set token.
 *
 * Usage:
 *   ci-hold.ts ensure [PR] --expect-head SHA
 *   ci-hold.ts release [PR] --expect-head SHA
 *   ci-hold.ts rollback [PR] --expect-head SHA
 *   ci-hold.ts final-ready [PR] --expect-head SHA [--require-success]
 *
 * `--require-success` (final-ready only) additionally requires the Schema
 * gate witness and every required check to have concluded `success`, not
 * merely `completed` — see `finalReady`'s own doc comment for why this is
 * opt-in rather than the default.
 */

import {
  CI_HOLD_LABEL,
  checkRunWatermark,
  ciHoldTransitions,
  completedHoldPrecondition,
  completedInitialSchemaGate,
  completedRequiredCi,
  freshSchemaGate,
  type LabelTransition,
  mutationProven,
  ownsHeldTransition,
  type PrSnapshot,
  parseCheckRuns,
  parsePrSnapshot,
} from "./lib/ci-hold.ts";
import { fail, isDigits, isGitSha, runMain, sleep } from "./lib/cli.ts";
import { ghCall, git, gitCallTimeoutSeconds, resolvePr } from "./lib/proc.ts";
import {
  assertRemoteMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs } from "./lib/state/lock.ts";
import type { CiHoldState } from "./lib/state/schema.ts";
import { openStore } from "./lib/state/store.ts";
import {
  checkRunsFor,
  ciVerdictOf,
  commitStatusesFor,
} from "./lib/status/evidence.ts";

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
    return parsePrSnapshot(JSON.parse(result.stdout) as unknown);
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
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
  ]);
  if (result.code !== 0) return null;
  try {
    const pages = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(pages)) return null;
    return ciHoldTransitions(pages.flat());
  } catch {
    return null;
  }
}

const latestOf = (values: readonly LabelTransition[]): LabelTransition | null =>
  values.at(-1) ?? null;

function exactSuccessor(
  values: readonly LabelTransition[],
  previousId: string | null,
): LabelTransition | null {
  const index =
    previousId === null
      ? -1
      : values.findIndex((transition) => transition.id === previousId);
  if (previousId !== null && index < 0) return null;
  return values.length === index + 2 ? (values.at(-1) ?? null) : null;
}

function transitionsFollowing(
  values: readonly LabelTransition[],
  previousId: string | null,
): LabelTransition[] | null {
  const index =
    previousId === null
      ? -1
      : values.findIndex((transition) => transition.id === previousId);
  if (previousId !== null && index < 0) return null;
  return values.slice(index + 1);
}

async function checkRuns(head: string) {
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/commits/${head}/check-runs?per_page=100`,
  ]);
  if (result.code !== 0) return null;
  try {
    return parseCheckRuns(JSON.parse(result.stdout) as unknown);
  } catch {
    return null;
  }
}

async function transitionAfter(
  pr: string,
  beforeId: string,
  event: "labeled" | "unlabeled",
  actor: string,
): Promise<{ event: LabelTransition; intervening: boolean } | null> {
  // GitHub's timeline can trail the label mutation briefly. Bound the retry;
  // an unobserved event is not ownership and must never be persisted as one.
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (attempt < 3) await sleep(2);
  }
  return null;
}

async function writeCiState(
  pr: string,
  state: CiHoldState | null,
): Promise<void> {
  const store = await openStore(pr);
  await store.update((current) => ({ ...current, ciHold: state }));
}

async function readCiState(pr: string): Promise<CiHoldState | null> {
  return (await openStore(pr)).read().state.ciHold;
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
      await writeCiState(pr, {
        phase: "released",
        eventId: successor.id,
        head,
        actor: successor.actor,
        createdAt: successor.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
        source: successor.actor === persisted.actor ? "drive" : "external",
      });
      console.error(
        "ci-hold: recovered an interrupted completed release; waiting for its full CI before another hold can be acquired",
      );
      return 4;
    }
    if (live.held && latest?.id === persisted.heldEventId) {
      persisted = {
        phase: "held",
        eventId: persisted.heldEventId,
        addedAtHead: persisted.addedAtHead,
        actor: persisted.heldActor,
        createdAt: persisted.heldCreatedAt,
        checkRunWatermark: persisted.checkRunWatermark,
      };
      await writeCiState(pr, persisted);
    } else if (!live.held && latest?.event === "unlabeled") {
      // More than one transition followed the intent (for example our
      // removal, a human re-add, then another human removal). We can no
      // longer attribute the final removal to this drive, but the live state
      // and newest event do prove an external release. Persist that evidence
      // so fresh full CI can eventually authorize another hold.
      await writeCiState(pr, {
        phase: "released",
        eventId: latest.id,
        head,
        actor: latest.actor,
        createdAt: latest.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
        source: "external",
      });
      console.error(
        "ci-hold: recovered an interrupted release with intervening transitions; waiting for fresh full CI",
      );
      return 4;
    } else {
      if (live.held) await writeCiState(pr, null);
      console.error(
        "ci-hold: interrupted release ownership changed; preserving the live label state",
      );
      return 4;
    }
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
      await writeCiState(pr, {
        phase: "released",
        eventId: latest.id,
        head,
        actor: latest.actor,
        createdAt: latest.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
        source: "external",
      });
      console.error(
        "ci-hold: recovered an interrupted acquisition followed by an external removal; waiting for fresh full CI",
      );
      return 4;
    } else if (
      afterIntent === null ||
      afterIntent.length > 0 ||
      (!live.held && successor === null)
    ) {
      await writeCiState(pr, null);
      console.error(
        `ci-hold: could not reconcile an interrupted label acquisition; preserving the live label state`,
      );
      return 4;
    } else {
      console.error(
        `ci-hold: interrupted label acquisition is not visible in the timeline yet; retrying later`,
      );
      return 4;
    }
  }

  if (live.held) {
    if (ownsHeldTransition(persisted, latest)) {
      process.stdout.write("owned\n");
      return 0;
    }
    await writeCiState(pr, null);
    console.error(
      `ci-hold: '${CI_HOLD_LABEL}' is present but its latest transition is not owned by this drive; leaving it untouched`,
    );
    return 4;
  }

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
  if (
    latest?.event === "unlabeled" &&
    !(
      persisted?.phase === "released" &&
      persisted.head === head &&
      persisted.eventId === latest.id
    )
  ) {
    await writeCiState(pr, null);
    console.error(
      `ci-hold: the latest '${CI_HOLD_LABEL}' removal is not a release owned by this drive; refusing to re-add it`,
    );
    return 4;
  }
  const observed = completedHoldPrecondition(
    runs,
    head,
    latest,
    watermark,
    persisted?.phase === "released" && persisted.source === "external",
  );
  if (observed === null) {
    console.error(
      latest?.event === "unlabeled"
        ? "ci-hold: the Schema gate triggered by the latest unlabel has not completed on this head; refusing to re-add the hold yet"
        : "ci-hold: initial Schema gate has not completed on this head; waiting before suppressing intermediate CI",
    );
    return 4;
  }
  const login = await viewer();
  if (login === null)
    fail(1, "ci-hold: cannot identify the authenticated GitHub actor");
  // Refresh immediately before the mutation while the PR-wide mutation fence
  // is held. A same-login human action through another client remains an API
  // limitation; any observable intervening transition is refused below.
  const beforeLive = await snapshot(pr);
  const beforeTimeline = await transitions(pr);
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
    head,
    actor: login,
    createdAt: new Date().toISOString(),
    checkRunWatermark: preHoldWatermark,
  });
  const add = await ghCall(["pr", "edit", pr, "--add-label", CI_HOLD_LABEL]);
  const mutation = await transitionAfter(pr, beforeId, "labeled", login);
  const confirmed = await snapshot(pr);
  if (mutation?.intervening === true) {
    await writeCiState(pr, null);
    console.error(
      `ci-hold: another '${CI_HOLD_LABEL}' transition raced label acquisition; leaving the live label untouched and refusing ownership`,
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

async function release(pr: string, head: string): Promise<number> {
  let persisted = await readCiState(pr);
  const live = await snapshot(pr);
  if (live === null) fail(1, "ci-hold: cannot read the PR state");
  if (live.state !== "OPEN") return 5;
  if (live.head !== head) return 4;
  const initialTimeline = await transitions(pr);
  if (initialTimeline === null)
    fail(1, "ci-hold: cannot read the label timeline");
  const latest = latestOf(initialTimeline);

  if (persisted?.phase === "releasing") {
    const successor = exactSuccessor(initialTimeline, persisted.heldEventId);
    if (
      !live.held &&
      persisted.head === head &&
      successor?.event === "unlabeled"
    ) {
      await writeCiState(pr, {
        phase: "released",
        eventId: successor.id,
        head,
        actor: successor.actor,
        createdAt: successor.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
        source: successor.actor === persisted.actor ? "drive" : "external",
      });
      process.stdout.write("removed\n");
      return 0;
    }
    if (
      live.held &&
      persisted.head === head &&
      latest?.id === persisted.heldEventId
    ) {
      persisted = {
        phase: "held",
        eventId: persisted.heldEventId,
        addedAtHead: persisted.addedAtHead,
        actor: persisted.heldActor,
        createdAt: persisted.heldCreatedAt,
        checkRunWatermark: persisted.checkRunWatermark,
      };
      await writeCiState(pr, persisted);
    } else if (!live.held && latest?.event === "unlabeled") {
      await writeCiState(pr, {
        phase: "released",
        eventId: latest.id,
        head,
        actor: latest.actor,
        createdAt: latest.createdAt,
        checkRunWatermark: persisted.checkRunWatermark,
        source: "external",
      });
      process.stdout.write("absent\n");
      return 0;
    } else if (live.held) {
      await writeCiState(pr, null);
      console.error(
        `ci-hold: could not reconcile an interrupted label release; preserving the live label state`,
      );
      return 4;
    } else {
      console.error(
        `ci-hold: interrupted label release is not visible in the timeline yet; retrying later`,
      );
      return 4;
    }
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
      await writeCiState(pr, {
        phase: "released",
        eventId: latest.id,
        head,
        actor: latest.actor,
        createdAt: latest.createdAt,
        checkRunWatermark: 0,
        source: "external",
      });
      process.stdout.write("absent\n");
      return 0;
    }
    await writeCiState(pr, null);
    process.stdout.write("absent\n");
    return 0;
  }

  if (!ownsHeldTransition(persisted, latest)) {
    await writeCiState(pr, null);
    console.error(
      `ci-hold: '${CI_HOLD_LABEL}' no longer matches this drive's labelled event; leaving it untouched`,
    );
    return 4;
  }
  if (persisted === null || persisted.phase !== "held") return 4;

  const login = await viewer();
  if (login === null)
    fail(1, "ci-hold: cannot identify the authenticated GitHub actor");
  const beforeLive = await snapshot(pr);
  const beforeTimeline = await transitions(pr);
  if (
    beforeLive === null ||
    beforeTimeline === null ||
    beforeLive.state !== "OPEN" ||
    beforeLive.head !== head ||
    !beforeLive.held ||
    !ownsHeldTransition(persisted, latestOf(beforeTimeline))
  )
    return 4;
  const beforeRuns = await checkRuns(head);
  const watermark =
    beforeRuns === null ? null : checkRunWatermark(beforeRuns, head);
  if (watermark === null)
    fail(1, "ci-hold: cannot establish the pre-unlabel check-run watermark");
  await writeCiState(pr, {
    phase: "releasing",
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
    CI_HOLD_LABEL,
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
        CI_HOLD_LABEL,
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
          `ci-hold: ownership changed during removal; add-label exited ${restore.code} and restoration could not be proven from the timeline and live label, so reconcile '${CI_HOLD_LABEL}' manually`,
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
 *   confirmation was therefore invisible to it (chatgpt-codex-connector,
 *   a reference-implementation pull request) — passing `requireSuccess: true` is what closes that race for
 *   this caller specifically, without changing what exit 4 means for the
 *   other one.
 */
/**
 * ONE predicate for "does CI genuinely prove this head is done and green" —
 * called for the INITIAL proof in `finalReady` AND, unchanged, for the
 * re-verification `stillCurrentForFinalReady` performs — the identical
 * reasoning `drive-state.ts`'s `proveCiGreen()` already applies for
 * `set-verified`. Two rounds running a SEPARATE, cheaper re-check fell out
 * of sync with the initial proof: round 12 added the aggregate
 * `ciVerdictOf` check but only ever re-verified IT on refresh, never
 * `completedRequiredCi`/the witness — so a required check superseded by a
 * fresher SKIPPED run (which `ciVerdictOf`'s own `PASSING_CONCLUSIONS`
 * treats as passing, unlike `completedRequiredCi`) slipped past the
 * re-check even though it would have failed the initial proof
 * (chatgpt-codex-connector, a reference-implementation pull request round 15). Sharing one implementation
 * makes that class of drift impossible rather than merely unlikely.
 *
 * Always re-fetches check-runs — never reuses a caller's earlier `runs` —
 * so every call is a genuinely fresh read, not a re-evaluation of data that
 * may already be stale by the time this runs a second time.
 */
async function finalCiProofGreen(
  head: string,
  persisted: Extract<CiHoldState, { phase: "released" }> | null,
  requireSuccess: boolean,
): Promise<{ ok: true; startedAt: string } | { ok: false }> {
  const runs = await checkRuns(head);
  if (runs === null) return { ok: false };
  const witness =
    persisted === null
      ? completedInitialSchemaGate(runs, head)
      : freshSchemaGate(
          runs,
          head,
          persisted.createdAt,
          persisted.checkRunWatermark,
          persisted.source === "external",
        );
  const requiredFresh =
    persisted === null
      ? completedRequiredCi(runs, head, undefined, requireSuccess)
      : completedRequiredCi(
          runs,
          head,
          persisted.createdAt,
          requireSuccess,
          persisted.checkRunWatermark,
          persisted.source === "external",
        );
  if (
    witness === null ||
    witness.startedAt === null ||
    (requireSuccess && witness.conclusion !== "success") ||
    !requiredFresh
  )
    return { ok: false };
  if (requireSuccess && !(await requiredCiAggregateIsGreen(head)))
    return { ok: false };
  return { ok: true, startedAt: witness.startedAt };
}

/**
 * The same aggregate CI verdict `drive-state.ts`'s `proveCiGreen()` already
 * requires — check-runs AND legacy commit statuses, not check-runs alone.
 * `finalReady`'s own witness/`completedRequiredCi` checks only ever read
 * check-runs, so a legacy status context turning pending or failing after
 * `announce-merge-ready.ts`'s initial snapshot was invisible to every later
 * `--require-success` confirmation, which could then post or preserve a
 * "Safe to merge" comment over a red aggregate verdict (chatgpt-codex-
 * connector, PR #4681 round 12). Gated behind `requireSuccess`, matching
 * every other strictness check `finalReady` already gates that way — `drive.ts`'s
 * own polling loop never passes it and derives green/red from
 * `drive-status.ts`'s `.ci` field separately, so this must not change what
 * `finalReady`'s return means for that caller.
 */
async function requiredCiAggregateIsGreen(head: string): Promise<boolean> {
  const [allRuns, statuses] = await Promise.all([
    checkRunsFor("{owner}", "{repo}", head),
    commitStatusesFor("{owner}", "{repo}", head),
  ]);
  if (allRuns === null || statuses === null) return false;
  return ciVerdictOf(allRuns, statuses, false, head) === "green";
}

/**
 * Re-proves CI green AND re-snapshots state, exact head, hold label, and the
 * label timeline right before `finalReady` commits to returning success —
 * closing (not just narrowing to the entry read) the window every earlier
 * read in this call spends on the network. A push or label re-add landing
 * in that window is otherwise invisible: this function only ever
 * snapshotted the PR once, at entry, unlike `set-verified` (drive-state.ts),
 * which already re-verifies before its own commit for the identical reason
 * (chatgpt-codex-connector, a reference-implementation pull request round 2).
 *
 * The CI proof runs FIRST, the PR/timeline snapshot LAST — the opposite
 * order round 13 used. `finalReady`'s caller cares most about exactly ONE
 * fact staying current at the instant this returns: whether `head` is
 * genuinely still the PR's head, unheld. Checking that LAST, after the CI
 * proof's own remote reads have already happened, shrinks the residual
 * race to that one final read's own round-trip — the same "nothing may
 * follow the last read" reasoning `document-scanning-gates.md`-adjacent
 * fail-closed checks in this codebase already apply (chatgpt-codex-
 * connector, PR #4681 round 15).
 *
 * `expectEmptyTimeline` selects which timeline shape the caller's branch
 * requires — `true` for "no hold was ever applied" (never a member other
 * than the always-empty initial branch), the persisted event id otherwise.
 */
async function stillCurrentForFinalReady(
  pr: string,
  head: string,
  persisted: Extract<CiHoldState, { phase: "released" }> | null,
  expectation: { emptyTimeline: true } | { latestTransitionId: string },
  requireSuccess: boolean,
): Promise<boolean> {
  if (requireSuccess) {
    const proof = await finalCiProofGreen(head, persisted, true);
    if (!proof.ok) return false;
  }
  // Timeline BEFORE head/state/held — round 15 put the CI proof first and
  // this snapshot last, but left `snapshot()` (the head check) running
  // BEFORE `transitions()`, so the head check was still not the temporally
  // last remote read: a push landing in the window `transitions()` spends
  // on the network was invisible (chatgpt-codex-connector, a reference-implementation pull request round
  // 17 — reasserting the same finding after round 15's reorder, since head
  // identity is exactly the one fact this function exists to keep fresh).
  // No further reordering closes the gap completely: GitHub's REST API has
  // no compare-and-swap, so SOME read is always last and a mutation landing
  // in ITS OWN round-trip stays unobservable — the identical, explicitly
  // accepted residual `drive-state.ts`'s own `stillFullyCurrent()`/
  // post-write check documents for the same reason. This ordering puts
  // that irreducible tail on the one fact worth protecting most.
  const finalTimeline = await transitions(pr);
  if (finalTimeline === null) return false;
  const timelineMatches =
    "emptyTimeline" in expectation
      ? finalTimeline.length === 0
      : latestOf(finalTimeline)?.id === expectation.latestTransitionId;
  if (!timelineMatches) return false;
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
  const persisted = await readCiState(pr);
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  if (persisted === null) {
    if (timeline.length !== 0) return 4;
    // No intermediate hold was ever applied: the PR-open Schema gate is the
    // full-CI witness for this exact head.
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
    process.stdout.write(`${initialProof.startedAt}\n`);
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
    live.head !== persisted.addedAtHead ||
    !live.held
  )
    return 4;
  const timeline = await transitions(pr);
  if (timeline === null) fail(1, "ci-hold: cannot read the label timeline");
  if (!ownsHeldTransition(persisted, latestOf(timeline))) return 4;
  return release(pr, live.head);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv.shift() ?? "";
  if (!["ensure", "release", "rollback", "final-ready"].includes(command))
    usage();
  let pr = "";
  let head = "";
  let requireSuccess = false;
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
      return await release(pr, head);
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
      remoteLock?.release();
      remoteLock?.dispose();
    }
  }
  return finalReady(pr, head, requireSuccess);
}

runMain("ci-hold.ts", main);
