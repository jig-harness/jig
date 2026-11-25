import { fileURLToPath } from "node:url";
import {
  echoDiagnostic,
  type ItemResult,
  type Report,
} from "./finish-round-report.ts";
import {
  helperTimeoutSeconds,
  run,
  summaryAnswerTimeoutSeconds,
  tsArgv,
} from "./proc.ts";
import { summaryAnswerProblem } from "./summary-answer.ts";
import { drainedThreadResult } from "./scanner-sweep-guard.ts";
import {
  DRIVE_HELD_ELSEWHERE_EXIT,
  SESSION_LEASE_HELD_EXIT,
} from "./state/lease.ts";

const driveState = fileURLToPath(new URL("../drive-state.ts", import.meta.url));
const resolveHeldThread = fileURLToPath(
  new URL("../resolve-held-thread.ts", import.meta.url),
);
const answerSummaryFinding = fileURLToPath(
  new URL("../answer-summary-finding.ts", import.meta.url),
);

function isLeaseExit(code: number): boolean {
  return code === SESSION_LEASE_HELD_EXIT || code === DRIVE_HELD_ELSEWHERE_EXIT;
}

export interface HeldRecord {
  key: string;
  kind: "thread" | "finding";
  outcome: string;
  round: number;
  reason?: string;
  actor: string;
  verifiedSha?: string;
  commentUrl?: string;
}

export interface ItemOutcome {
  result: ItemResult;
  /** A `claim-held` exit 4 — re-read the batch before continuing. */
  stale?: boolean;
  /** Set when the whole drain must stop, not just this key. */
  abort?: { code: number; state: Report["state"]; why: string };
}

/**
 * A held THREAD, resolved only through the wrapper — never `resolve-thread.ts`
 * directly, whose mutation is unconditional and has no notion of which push
 * justifies it. The wrapper's `claim-held --kind thread` is both
 * the provenance check and the thread's OWN claim, in one lock hold, so there
 * is no separate claim/release pair on this path.
 */
export async function resolveThreadItem(
  pr: string,
  item: HeldRecord,
  head: string,
): Promise<ItemOutcome> {
  const res = await run(
    tsArgv(resolveHeldThread, ["--key", item.key, "--pushed-sha", head, pr]),
    { stderr: "pipe", timeoutSec: helperTimeoutSeconds() },
  );
  if (isLeaseExit(res.code)) {
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: res.code,
        diagnostic: res.stderr,
      },
      abort: {
        code: res.code,
        state: "LEASE_HELD",
        why: `resolve-held-thread.ts refused with exit ${res.code}`,
      },
    };
  }
  if (res.code === 3) {
    // The stored state itself is unreadable — `resolve-held-thread.ts`
    // reaches this both through its own precheck `drive-state.ts held` call
    // and through `claim-held`, either of which propagates `store.ts`'s
    // `ExitError(3)` verbatim on a malformed stored state. Not a per-key
    // problem — `claimFinding` already treats the identical exit from
    // the finding path as a batch-level abort; this mirrors it, rather than
    // iterating the rest of an untrustworthy snapshot one silently-refused
    // thread at a time.
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: 3,
        diagnostic: res.stderr,
      },
      abort: {
        code: 1,
        state: "BATCH_UNREADABLE",
        why: "drive-state.ts could not read this PR's state — stopping the drain rather than operating on unreadable state",
      },
    };
  }
  if (res.code !== 0) {
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: res.code,
        diagnostic: res.stderr,
      },
      // Mirrors the finding path's `claimRes.code === 4` handling above.
      // `resolve-held-thread.ts` returns exit 4 — from either its own `held`
      // precheck or the `claim-held --kind thread` call it wraps — when the
      // key is no longer in the held batch at all, which is the snapshot
      // going stale (a concurrent operation, most often this very thread's
      // own resolve, already removed it since this drain's last read), not a
      // property of this item. Recording it as a permanent refusal made the
      // drain return PARTIAL/6 over work that had already finished.
      stale: res.code === 4,
    };
  }
  return { result: drainedThreadResult(item.key, item.kind, res) };
}

function refused(
  item: HeldRecord,
  code: number,
  diagnostic: string,
): ItemOutcome {
  return {
    result: {
      key: item.key,
      kind: item.kind,
      action: "refused",
      code,
      diagnostic,
    },
  };
}

type FindingClaim = { item: HeldRecord; token: string };

async function claimFinding(
  pr: string,
  item: HeldRecord,
  head: string,
): Promise<FindingClaim | ItemOutcome> {
  const refusal = (code: number, diagnostic: string) =>
    refused(item, code, diagnostic);
  const problem = summaryAnswerProblem(item.key, item.reason ?? "");
  if (problem !== undefined) {
    const diagnostic = `finish-round.ts: held finding '${item.key}' has an invalid answer: ${problem}. Re-hold it via SKILL.md § 3.\n`;
    echoDiagnostic("finish-round.ts", diagnostic);
    return refusal(2, diagnostic);
  }

  const claimRes = await run(
    tsArgv(driveState, [
      "claim-held",
      pr,
      "--key",
      item.key,
      "--kind",
      "finding",
      "--pushed-sha",
      head,
    ]),
    { stderr: "pipe", timeoutSec: helperTimeoutSeconds() },
  );
  if (claimRes.code !== 0) {
    echoDiagnostic("claim-held", claimRes.stderr);
    if (isLeaseExit(claimRes.code)) {
      return {
        ...refusal(claimRes.code, claimRes.stderr),
        abort: {
          code: claimRes.code,
          state: "LEASE_HELD",
          why: `drive-state.ts claim-held refused with exit ${claimRes.code}`,
        },
      };
    }
    // Exit 3 is the stored state itself being unreadable — not a per-key
    // problem, so the round stops rather than iterating an entire batch one
    // silently-failing key at a time. Exit 4 is a stale snapshot: re-read.
    // Everything else (1, and the usage codes) is per-key — skip it, keep
    // going, and let the report carry the refusal.
    if (claimRes.code === 3) {
      return {
        ...refusal(3, claimRes.stderr),
        abort: {
          code: 1,
          state: "BATCH_UNREADABLE",
          why: "drive-state.ts could not read this PR's state — stopping the drain rather than operating on unreadable state",
        },
      };
    }
    return {
      ...refusal(claimRes.code, claimRes.stderr),
      stale: claimRes.code === 4,
    };
  }
  const token = claimRes.stdout.trim();
  if (token === "") {
    // A claim that printed no token cannot be released or unclaimed, so it
    // must not be dispatched against either: the key would be wedged behind a
    // claim nothing can give back. Reported, not worked around.
    const diagnostic =
      "claim-held printed no token — refusing to dispatch a claim this script could not release. Inspect 'drive-state.ts get'.\n";
    echoDiagnostic("finish-round.ts", diagnostic);
    return refusal(1, diagnostic);
  }

  return { item, token };
}

async function settleFinding(
  pr: string,
  { item, token }: FindingClaim,
  head: string,
  answerRes: Awaited<ReturnType<typeof run>>,
): Promise<ItemOutcome> {
  const refusal = (code: number, diagnostic: string) =>
    refused(item, code, diagnostic);
  if (answerRes.code !== 0) {
    // Give the claim back immediately rather than leaving it to expire, so a
    // retry — this round or the next — is not blocked behind the staleness
    // window. The retry must still start with a fresh `claim-held`: this
    // token is dead the moment `unclaim-held` accepts it.
    const unclaimRes = await unclaimFinding(pr, { item, token });
    if (isLeaseExit(answerRes.code)) {
      return {
        ...refusal(answerRes.code, answerRes.stderr),
        abort: {
          code: answerRes.code,
          state: "LEASE_HELD",
          why: `answer-summary-finding.ts refused with exit ${answerRes.code}`,
        },
      };
    }
    // A lease refusal from the cleanup itself is still a lease refusal from
    // "any step" (see isLeaseExit's contract) even though the answer dispatch
    // that provoked it failed for an ordinary reason — flattening it into an
    // per-key refused/6 would leave the claim live and block recovery until
    // the staleness window expires instead of ending the run now.
    if (isLeaseExit(unclaimRes.code)) {
      return {
        ...refusal(answerRes.code, answerRes.stderr),
        abort: {
          code: unclaimRes.code,
          state: "LEASE_HELD",
          why: `unclaim-held refused with exit ${unclaimRes.code}`,
        },
      };
    }
    // A non-lease unclaim failure leaves the claim live rather than reverting
    // it to reclaimable — a fact the report must carry alongside the answer's
    // own refusal, not just echo to a scrollback an unattended pass never
    // reads.
    return refusal(
      answerRes.code,
      unclaimRes.code === 0
        ? answerRes.stderr
        : `${answerRes.stderr}\nunclaim-held also failed (exit ${unclaimRes.code}) — the claim on '${item.key}' remains live rather than reclaimable:\n${unclaimRes.stderr}`,
    );
  }

  const releaseRes = await run(
    tsArgv(driveState, [
      "release-held",
      pr,
      "--key",
      item.key,
      "--token",
      token,
    ]),
    { stderr: "pipe", timeoutSec: helperTimeoutSeconds() },
  );
  if (releaseRes.code !== 0) {
    echoDiagnostic("release-held", releaseRes.stderr);
    const out = refusal(
      releaseRes.code,
      `finish-round.ts: the ANSWER for '${item.key}' was posted successfully; only the release failed, so the entry is still held at ${head}.\n${releaseRes.stderr}`,
    );
    // A lease refusal here means another driver has taken over since the
    // answer posted — the same "any step" contract as every other lease
    // check, and the reason this one must abort rather than fall through to
    // the ordinary reconcile-and-rerun path below: continuing would dispatch
    // the REST of this batch against a lease that is no longer this
    // process's to hold.
    if (isLeaseExit(releaseRes.code)) {
      return {
        ...out,
        abort: {
          code: releaseRes.code,
          state: "LEASE_HELD",
          why: `release-held refused with exit ${releaseRes.code}`,
        },
      };
    }
    // Exit 3 is the stored state itself being unreadable — not a per-key problem,
    // the same "malformed, refuse" condition the claim step already aborts the
    // whole drain over (`claimRes.code === 3` above) and `resolveThreadItem`
    // mirrors for the thread path. Falling through to an ordinary per-item
    // refusal here left a batch-level failure looking like one bad key: if this
    // was the last item, the drain returns PARTIAL/6 naming ONE finding to
    // reconcile, when the real problem is that nothing in `held` can be trusted
    // right now.
    if (releaseRes.code === 3) {
      return {
        ...out,
        abort: {
          code: 1,
          state: "BATCH_UNREADABLE",
          why: `release-held could not read this PR's state after posting the answer for '${item.key}' — the answer stands, but stopping the drain rather than operating on unreadable state`,
        },
      };
    }
    // The ANSWER is already on the PR — that is the irreversible half, and it
    // succeeded. A failed, non-lease, non-3 release leaves the entry held at
    // the SHA it was answered under, which the next `claim-held` refuses
    // (correctly: it is what stops a duplicate comment) and whose recovery
    // that refusal itself prints. Reported as a refusal so the round does not
    // read as clean, and NOT retried here: the token is still valid, so a
    // human or a re-run can release it, and a retry loop over a stored state
    // that just refused a write is not a recovery.
    return out;
  }
  return {
    result: { key: item.key, kind: item.kind, action: "answered", code: 0 },
  };
}

async function unclaimFinding(pr: string, { item, token }: FindingClaim) {
  const unclaimRes = await run(
    tsArgv(driveState, [
      "unclaim-held",
      pr,
      "--key",
      item.key,
      "--token",
      token,
    ]),
    { stderr: "pipe", timeoutSec: helperTimeoutSeconds() },
  );
  if (unclaimRes.code !== 0) {
    echoDiagnostic("unclaim-held", unclaimRes.stderr);
  }
  return unclaimRes;
}

/** Claim eligible findings before posting a single reply, then settle each claim. */
export async function answerFindingBatch(
  pr: string,
  items: HeldRecord[],
  head: string,
  attempt: (item: HeldRecord) => void,
): Promise<ItemOutcome[]> {
  const claims: FindingClaim[] = [];
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    const claimed = await claimFinding(pr, item, head);
    if ("token" in claimed) {
      // Count the attempt once delivery actually runs. A stale snapshot may
      // force us to release this claim before sending anything.
      claims.push(claimed);
      continue;
    }
    attempt(item);
    outcomes.push(claimed);
    if (claimed.abort || claimed.stale) {
      return [...outcomes, ...(await cancelFindingClaims(pr, claims))];
    }
  }
  if (claims.length === 0) return outcomes;

  return [
    ...outcomes,
    ...(await deliverFindingAnswers(pr, claims, head, attempt)),
  ];
}

async function cancelFindingClaims(
  pr: string,
  claims: FindingClaim[],
): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];
  for (const claim of claims) {
    const cleanup = await unclaimFinding(pr, claim);
    if (isLeaseExit(cleanup.code)) {
      outcomes.push({
        ...refused(claim.item, cleanup.code, cleanup.stderr),
        abort: {
          code: cleanup.code,
          state: "LEASE_HELD",
          why: `unclaim-held refused with exit ${cleanup.code}`,
        },
      });
      break;
    }
    if (cleanup.code !== 0)
      outcomes.push(refused(claim.item, cleanup.code, cleanup.stderr));
  }
  return outcomes;
}

async function deliverFindingAnswers(
  pr: string,
  claims: FindingClaim[],
  head: string,
  attempt: (item: HeldRecord) => void,
): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];
  const answers = claims.map(({ item }) => {
    attempt(item);
    return {
      fingerprint: item.key,
      outcome: item.outcome,
      reason: item.reason,
    };
  });
  const answer = await run(
    tsArgv(answerSummaryFinding, ["--batch", "--pushed-sha", head, pr]),
    {
      stderr: "pipe",
      stdin: JSON.stringify(answers),
      timeoutSec: summaryAnswerTimeoutSeconds(),
    },
  );
  if (answer.code !== 0)
    echoDiagnostic("answer-summary-finding.ts", answer.stderr);
  for (const claim of claims) {
    const outcome = await settleFinding(pr, claim, head, answer);
    outcomes.push(outcome);
    if (outcome.abort && answer.code === 0) break;
  }
  return outcomes;
}
