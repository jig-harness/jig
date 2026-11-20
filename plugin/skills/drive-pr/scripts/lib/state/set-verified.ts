/** `set-verified`: record a head as globally green once fresh CI proves it. */
import {
  completedRequiredCi,
  parseCheckRuns,
  parsePrSnapshot,
  requirementsWithoutRun,
} from "../ci-hold.ts";
import { type CiPolicy, ciPolicy } from "../ci-policy.ts";
import { exitOnProof, unreadable } from "../ci-proof.ts";
import { fail, isGitSha } from "../cli.ts";
import {
  type ListingCutShort,
  listingCutShort,
  slurpCheckRuns,
} from "../paged-read.ts";
import { ghCall } from "../proc.ts";
import {
  attributeStatuses,
  checkRunListing,
  ciVerdictOf,
  commitStatusesFor,
  hasNonReviewerCi,
} from "../status/evidence.ts";
import {
  withoutRerunning,
  withoutSuperseded,
  workflowRunsBehind,
} from "../status/workflow-runs.ts";
import { holdLabel, holdLabelName, readCiHoldTimeline } from "./hold-label.ts";
import { assertRemoteMutationAllowed, resolveFenceContext } from "./lease.ts";
import { lockHeartbeatMs } from "./lock.ts";
import { type DriveState, withProgress } from "./schema.ts";
import type { StateStore } from "./store.ts";

type CiProof =
  | { ok: true }
  | { ok: false; reason: string; cutShort?: ListingCutShort };

/** What the proofs below measure a head against. */
interface VerifyContext {
  pr: string;
  sha: string;
  policy: CiPolicy;
  settledHold: StateStoreHold;
  expectedTransition: number | string | null;
}

type StateStoreHold = Extract<
  NonNullable<DriveState["ciHold"]>,
  { phase: "released" }
> | null;

const readSnapshot = async (
  pr: string,
): Promise<ReturnType<typeof parsePrSnapshot>> => {
  const live = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (live.code !== 0) return null;
  let snapshot: ReturnType<typeof parsePrSnapshot> = null;
  try {
    snapshot = parsePrSnapshot(JSON.parse(live.stdout) as unknown, holdLabel());
  } catch {
    snapshot = null;
  }
  return snapshot;
};

const timelineSettled = (
  timeline: Awaited<ReturnType<typeof readCiHoldTimeline>>,
  expectedTransition: number | string | null,
): boolean =>
  timeline !== null &&
  (expectedTransition === null
    ? timeline.length === 0
    : timeline.at(-1)?.id === expectedTransition);

const readTimeline = async (ctx: VerifyContext) =>
  ctx.policy.holdLabel === null ? [] : await readCiHoldTimeline(ctx.pr);

/** The PR must be open, on `sha` and free of the hold label. */
async function requireOpenOnHead(pr: string, sha: string): Promise<void> {
  const live = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (live.code !== 0) fail(1, "set-verified: cannot read the PR");
  let snapshot: ReturnType<typeof parsePrSnapshot>;
  try {
    snapshot = parsePrSnapshot(JSON.parse(live.stdout) as unknown, holdLabel());
  } catch {
    fail(1, "set-verified: cannot parse the PR snapshot");
  }
  if (snapshot === null) fail(1, "set-verified: PR snapshot is malformed");
  if (snapshot.state !== "OPEN") fail(5, `set-verified: PR #${pr} is not open`);
  if (snapshot.head !== sha) {
    fail(4, `set-verified: PR head is ${snapshot.head}, not ${sha}`);
  }
  if (snapshot.held) {
    fail(4, `set-verified: '${holdLabelName()}' is still present`);
  }
}

/** The recorded hold, when its transition is settled and belongs to `sha`. */
function settledHoldFor(current: DriveState, sha: string): StateStoreHold {
  if (current.ciHold !== null && current.ciHold.phase !== "released") {
    fail(4, `set-verified: '${holdLabelName()}' transition is not settled`);
  }
  // Without a hold label every push ran full CI, so a released record
  // left by an earlier drive is settled history, not evidence this head
  // must be measured against.
  const settledHold = holdLabel() === null ? null : current.ciHold;
  if (settledHold !== null && settledHold.head !== sha) {
    fail(4, "set-verified: the recorded unlabel belongs to another head");
  }
  return settledHold;
}

async function policyFor(pr: string): Promise<CiPolicy> {
  try {
    return await ciPolicy(pr);
  } catch (error) {
    return fail(
      1,
      `set-verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Fresh check-runs for `sha`, or the reason they cannot be used. */
async function readRequiredRuns(
  sha: string,
): Promise<
  { runs: NonNullable<ReturnType<typeof parseCheckRuns>> } | { fail: CiProof }
> {
  const checks = await slurpCheckRuns("{owner}", "{repo}", sha, "fresh");
  if (checks.code !== 0) {
    return {
      fail: unreadable(
        { reason: "cannot read check-runs" },
        listingCutShort(sha, checks),
      ),
    };
  }
  let runs: ReturnType<typeof parseCheckRuns>;
  try {
    runs = parseCheckRuns(JSON.parse(checks.stdout) as unknown);
  } catch {
    runs = null;
  }
  if (runs === null) {
    return { fail: { ok: false, reason: "check-runs are malformed" } };
  }
  return { runs };
}

type Runs = NonNullable<ReturnType<typeof parseCheckRuns>>;

/** Whether the required checks all succeeded since the hold was released. */
async function requiredChecksFresh(
  ctx: VerifyContext,
  runs: Runs,
  statuses: NonNullable<Awaited<ReturnType<typeof commitStatusesFor>>>,
): Promise<boolean | null> {
  const { policy, settledHold, sha } = ctx;
  const apps = policy.requiredApps;
  if (settledHold !== null) {
    return completedRequiredCi(
      runs,
      policy.requiredChecks,
      sha,
      settledHold.createdAt,
      true,
      settledHold.checkRunWatermark,
      settledHold.source === "external",
      false,
      { apps },
    );
  }
  const attributed = await attributeStatuses(
    "{owner}",
    "{repo}",
    sha,
    statuses,
    requirementsWithoutRun(runs, policy.requiredChecks, sha, apps).flatMap(
      (r) => (r.appId === undefined ? [] : [r.context]),
    ),
  );
  if (attributed === null) return null;
  return completedRequiredCi(
    runs,
    policy.requiredChecks,
    sha,
    undefined,
    true,
    0,
    false,
    policy.holdLabel === null,
    { apps, statuses: attributed },
  );
}

// ONE predicate for "does CI genuinely prove this head is done and green" —
// called for the INITIAL proof AND, unchanged, for every later re-check
// `stillFullyCurrent()` performs: an aggregate-only `ciVerdictOf` re-check
// treats `skipped` as passing, so a newer skipped run for a required check
// could supersede the successful post-unlabel run, even though
// `completedRequiredCi` rejects it. Sharing one implementation makes that
// class of drift impossible. Every read in it is fresh (`lib/paged-read.ts`):
// it proves CI green.
async function proveCiGreen(ctx: VerifyContext): Promise<CiProof> {
  const { policy, sha } = ctx;
  const read = await readRequiredRuns(sha);
  if ("fail" in read) return read.fail;
  const [{ runs: allRuns, cutShort: secondCut }, statuses] = await Promise.all([
    checkRunListing("{owner}", "{repo}", sha),
    commitStatusesFor("{owner}", "{repo}", sha),
  ]);
  if (secondCut !== null || allRuns === null || statuses === null) {
    return unreadable(
      { reason: "cannot read complete CI evidence" },
      secondCut,
    );
  }
  const workflowRuns = await workflowRunsBehind(
    "{owner}",
    "{repo}",
    sha,
    allRuns,
  );
  const runs = withoutRerunning(
    withoutSuperseded(read.runs, workflowRuns),
    workflowRuns,
  );
  const requiredFresh = await requiredChecksFresh(ctx, runs, statuses);
  if (requiredFresh === null) {
    return { ok: false, reason: "cannot read commit status publishers" };
  }
  if (!requiredFresh) {
    return {
      ok: false,
      reason:
        "the required checks have not all succeeded on this head since the hold was last released",
    };
  }
  const verdict = ciVerdictOf(allRuns, statuses, false, sha, workflowRuns);
  if (verdict !== "green") {
    return { ok: false, reason: `final non-reviewer CI is '${verdict}'` };
  }
  // Branch protection names no check, and with nothing registered
  // on the head the verdict above reads green.
  if (
    policy.requiredChecks.length === 0 &&
    policy.derived &&
    !hasNonReviewerCi(allRuns, statuses)
  ) {
    return { ok: false, reason: "no CI has registered on this head" };
  }
  return { ok: true };
}

// ONE predicate for "is the PR still exactly what we verified", called
// identically before AND after the write in `setVerified` — a compensating
// post-write check that asked a NARROWER question than its pre-write
// counterpart (state/head/held only, no timeline re-check) let a human
// remove/re-add/remove `ci:hold` between `readTimeline()` and the write leave
// `verifiedSha` set over a superseded transition that `ci-hold.ts
// final-ready` would now reject. Sharing one implementation makes that drift
// impossible rather than merely unlikely.
//
// CI proof FIRST, PR/timeline snapshot LAST, matching the order
// `ci-hold.ts`'s `stillCurrentForFinalReady()` applies for the identical
// reason: the pre-write call stops the write from ever making a certificate
// the post-write check would immediately have to clear again.
async function stillFullyCurrent(ctx: VerifyContext): Promise<CiProof> {
  const ci = await proveCiGreen(ctx);
  if (!ci.ok) return ci;
  if (!timelineSettled(await readTimeline(ctx), ctx.expectedTransition)) {
    return { ok: false, reason: `${holdLabelName()} changed` };
  }
  const snap = await readSnapshot(ctx.pr);
  if (snap?.state !== "OPEN" || snap.head !== ctx.sha || snap.held) {
    return {
      ok: false,
      reason: `PR state, head, or ${holdLabelName()} changed`,
    };
  }
  return { ok: true };
}

async function verifyHead(
  pr: string,
  sha: string,
  store: StateStore,
): Promise<void> {
  await requireOpenOnHead(pr, sha);
  const current = store.read().state;
  const settledHold = settledHoldFor(current, sha);
  const ctx: VerifyContext = {
    pr,
    sha,
    policy: await policyFor(pr),
    settledHold,
    expectedTransition: settledHold?.eventId ?? null,
  };
  if (!timelineSettled(await readTimeline(ctx), ctx.expectedTransition)) {
    fail(
      4,
      `set-verified: ${holdLabelName()} transition history is not settled`,
    );
  }
  const initialCi = await proveCiGreen(ctx);
  if (!initialCi.ok) {
    exitOnProof(initialCi, 4, (r) => `set-verified: ${r}`);
  }
  const preWrite = await stillFullyCurrent(ctx);
  if (!preWrite.ok) {
    exitOnProof(
      preWrite,
      4,
      (r) => `set-verified: ${r} while final evidence was read`,
    );
  }
  await store.update((s) => {
    if (JSON.stringify(s.ciHold) !== JSON.stringify(current.ciHold)) {
      fail(
        4,
        `set-verified: ${holdLabelName()} changed before verification commit`,
      );
    }
    return { ...s, verifiedSha: sha };
  });
  // The write above cannot be made atomic with a remote read — GitHub's
  // REST API has no compare-and-swap. A push, ci:hold re-add, or
  // remove/re-add/remove landing in the narrow window between the
  // pre-write check above and this write would otherwise leave
  // `verifiedSha` certifying a head or transition that is no longer
  // current, invisible to every later reader of this pointer
  // (round-plan.ts's Testbox decay, the handoff header). Close it with
  // a compensating check-and-clear immediately after the write instead.
  const postWrite = await stillFullyCurrent(ctx);
  if (!postWrite.ok) {
    await store.update((s) =>
      s.verifiedSha === sha ? { ...s, verifiedSha: "" } : s,
    );
    exitOnProof(
      postWrite,
      4,
      (r) =>
        `set-verified: ${r} immediately after the verification commit; certificate cleared`,
    );
  }
  // Global CI verification landed — stamped only here, AFTER both the
  // pre-write and post-write checks passed, never on the provisional
  // `verifiedSha` write above (the compensating clear can still undo it).
  // Phased `'ci-verified'`, NOT `'push-landed'`: this call proves an
  // ALREADY-pushed SHA is globally green; it pushes nothing itself.
  await store.update((s) =>
    withProgress(s, "ci-verified", Temporal.Now.instant()),
  );
}

export async function setVerified(
  pr: string,
  sha: string,
  store: StateStore,
): Promise<number> {
  if (sha === "") fail(2, "set-verified requires --sha SHA");
  if (!isGitSha(sha)) {
    fail(
      2,
      `set-verified: --sha must be a full 40-character lowercase hex SHA-1 (got '${sha}') — the exact grammar 'git rev-parse HEAD' emits.`,
    );
  }
  const remoteFence = await resolveFenceContext("set-verified");
  const remoteLock =
    remoteFence === null
      ? null
      : await assertRemoteMutationAllowed(remoteFence, pr, "set-verified");
  const remoteHeartbeat =
    remoteLock === null
      ? null
      : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
  try {
    await verifyHead(pr, sha, store);
    return 0;
  } finally {
    if (remoteHeartbeat !== null) clearInterval(remoteHeartbeat);
    remoteLock?.release();
    remoteLock?.dispose();
  }
}
