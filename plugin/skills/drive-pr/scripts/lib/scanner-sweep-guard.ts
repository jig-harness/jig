import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alertNumberOf,
  isCodeScanningLogin,
  readAlert,
} from "../../../resolve-review-comments/scripts/lib/code-scanning.ts";
import { hasLeaveOpenMarker } from "./outcome.ts";
import { ghCall, run, tsArgv } from "./proc.ts";

const resolveThread = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "resolve-thread.ts",
);

/** The alert states that let a code-scanning thread close, per outcome. */
const SETTLED_STATES: Record<"declined" | "moot", ReadonlySet<string>> = {
  declined: new Set(["dismissed"]),
  moot: new Set(["fixed", "closed", "dismissed"]),
};

/**
 * A code-scanning finding answered with a merit outcome can close only over
 * a settled alert: a declined one (`rejected`/`wont-fix`/`deferred`) once
 * dismissal is verified, a plain `moot` once the alert is fixed, closed or
 * dismissed (resolve-review-comments SKILL.md's code-scanning outcome table).
 * `alert` is `undefined` for a thread with no alert; one GitHub's code
 * scanning account opened (`openedByCodeScanning`) always has one, so there
 * `undefined` means the alert could not be identified and the thread stays
 * open.
 */
export function mayResolveDeclinedAlert(
  alert: unknown,
  outcome: "declined" | "moot" = "declined",
  openedByCodeScanning = false,
): boolean {
  if (alert === undefined) return !openedByCodeScanning;
  if (typeof alert !== "object" || alert === null || Array.isArray(alert))
    return false;
  const record = alert as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    SETTLED_STATES[outcome].has(record.state) &&
    record.unreadable === undefined
  );
}

/**
 * Whether GitHub's code scanning account opened the thread. Such a thread's
 * `moot` is never held: the alert's state, not a push, is what proves it
 * (`mayResolveDeclinedAlert`).
 */
function openedByCodeScanning(
  opening: { author: string | null } | undefined,
): boolean {
  return isCodeScanningLogin(opening?.author);
}

/**
 * Whether `triage-thread.ts` holds a `moot` on the thread opened by `opening`
 * for a push. A reconciled `moot` (`existingOutcome`) is held unless its
 * reply carries LEAVE_OPEN_MARKER, a fresh one as `--moot-pending-push`
 * says. A code-scanning thread's `moot` is never held, fresh or reconciled:
 * it is judged on its alert (`resolveDeclinedThread`), since a held moot's
 * later release would resolve without reading the alert.
 */
export function mootHeld(
  opening: { author: string | null } | undefined,
  mootPendingPush: boolean,
  existingOutcome: string | null,
  existingBody: string | null,
): boolean {
  if (openedByCodeScanning(opening)) {
    if (mootPendingPush) {
      console.error(
        "triage-thread.ts: --moot-pending-push does not apply to a code-scanning thread; its moot stands only once the alert is fixed, closed or dismissed.",
      );
    }
    return false;
  }
  return existingOutcome === "moot"
    ? !hasLeaveOpenMarker(existingBody ?? "")
    : mootPendingPush;
}

/** The outcomes that resolve a thread without a push. */
const DECLINED_OUTCOMES = new Set(["rejected", "wont-fix", "deferred"]);

/**
 * Whether the last qualifying reply `outcome` (body `body`) on the thread
 * opened by `opening` is a merit disposition, one that supersedes an earlier
 * `accepted`/`moot` hold: a declined outcome, or a `moot` that `mootHeld`
 * never holds (LEAVE_OPEN_MARKER, or a code-scanning thread). Both of
 * `triage-thread.ts`'s stale-hold cleanups, `--cleanup-only` and the
 * already-resolved retry, decide by it.
 */
export function confirmedMeritSupersession(
  opening: { author: string | null } | undefined,
  outcome: string | null,
  body: string | null,
): boolean {
  if (outcome !== null && DECLINED_OUTCOMES.has(outcome)) return true;
  return outcome === "moot" && !mootHeld(opening, false, outcome, body);
}

/**
 * Whether an unresolved, unheld thread opened by `opening` and answered
 * `outcome` is fully triaged in `finish-round.ts`'s untriaged-thread check: a
 * code-scanning thread answered with a merit outcome or `moot` waits on its
 * alert, not on a hold, and the replied-thread sweep closes it once
 * `sweepVerdict` finds the alert settled. A `moot` resting on this round's
 * own fix settles only after the push, so refusing the push would deadlock it.
 */
export function awaitsAlert(
  opening: { author: string | null } | undefined,
  outcome: string | null,
): boolean {
  return (
    openedByCodeScanning(opening) &&
    outcome !== null &&
    (DECLINED_OUTCOMES.has(outcome) || outcome === "moot")
  );
}

/**
 * What the replied-thread sweep does with a reply of `outcome` that carries
 * no LEAVE_OPEN_MARKER: `null` to hold it for a push (`accepted`, or a `moot`
 * on a thread GitHub's code scanning account did not open); else resolve it
 * now, unless `leftOpen` names the alert state that is not yet confirmed.
 */
export function sweepVerdict(
  outcome: string,
  opening: { author: string | null } | undefined,
  alert: unknown,
): { leftOpen?: string } | null {
  const scanning = openedByCodeScanning(opening);
  const kind = DECLINED_OUTCOMES.has(outcome)
    ? "declined"
    : outcome === "moot" && scanning
      ? "moot"
      : null;
  if (kind === null) return null;
  if (mayResolveDeclinedAlert(alert, kind, scanning)) return {};
  return {
    leftOpen: kind === "moot" ? "fixed, closed or dismissed" : "dismissed",
  };
}

/** The repository and pull request of review thread `threadId`, or `null`. */
async function threadRepository(
  threadId: string,
  timeoutSec: number,
): Promise<{ owner: string; repo: string; pr: string } | null> {
  const r = await ghCall(
    [
      "api",
      "graphql",
      "-f",
      "query=query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { pullRequest { number repository { owner { login } name } } } } }",
      "-f",
      `id=${threadId}`,
      "-q",
      '.data.node.pullRequest | [.repository.owner.login, .repository.name, (.number | tostring)] | join(" ")',
    ],
    { timeoutSec },
  );
  const [owner = "", repo = "", pr = ""] = r.stdout.trim().split(" ");
  if (r.code !== 0 || owner === "" || repo === "" || !/^[0-9]+$/.test(pr))
    return null;
  return { owner, repo, pr };
}

/**
 * The alert behind thread `threadId`, in the shape `mayResolveDeclinedAlert`
 * judges: `undefined` unless GitHub's code scanning account opened it, as
 * `list-unresolved-threads.ts` reports it. A code-scanning thread whose
 * repository cannot be read, or whose comment names no single alert of that
 * repository, yields `null`, which keeps it open.
 */
export async function declinedAlertOf(
  threadId: string,
  opening: { author: string | null; body: string | null } | undefined,
  timeoutSec: number,
): Promise<unknown> {
  if (opening === undefined || !isCodeScanningLogin(opening.author))
    return undefined;
  const where = await threadRepository(threadId, timeoutSec);
  if (where === null) return null;
  const number = alertNumberOf(
    opening.body,
    opening.author,
    where.owner,
    where.repo,
  );
  if (number === null) return null;
  return readAlert(where.owner, where.repo, number, where.pr);
}

/**
 * `resolve-held-thread.ts`'s mutation for held thread `threadId`: resolve
 * it, unless its held `outcome` is a `moot`, GitHub's code scanning account
 * opened it (`opening`, as the live-comments read returns it), and its alert
 * is not fixed, closed or dismissed. Such a hold predates `mootHeld`'s rule,
 * so the thread stays open (`code` 0, `stdout` `false`) and the
 * replied-thread sweep closes it once the alert settles, as for a fresh one.
 */
export async function resolveHeldUnlessAlertOpen(
  threadId: string,
  opening:
    | { author: { login: string } | null; body: string | null }
    | undefined,
  outcome: string,
  timeoutSec: number,
): Promise<{ code: number; stdout: string }> {
  const comment = {
    author: opening?.author?.login ?? null,
    body: opening?.body ?? null,
  };
  if (outcome === "moot" && awaitsAlert(comment, outcome)) {
    const alert = await declinedAlertOf(threadId, comment, timeoutSec);
    if (!mayResolveDeclinedAlert(alert, "moot", true)) {
      console.error(
        `resolve-held-thread.ts: thread '${threadId}''s code scanning alert is not confirmed fixed, closed or dismissed — hold drained, thread left open for the replied-thread sweep.`,
      );
      return { code: 0, stdout: "false\n" };
    }
  }
  return run(tsArgv(resolveThread, [threadId]), {
    timeoutSec,
    stderr: "inherit",
  });
}

/**
 * Resolve thread `threadId` for merit outcome `outcome`, unless it is a
 * code-scanning thread whose alert is not settled for it
 * (`mayResolveDeclinedAlert`): then it stays open and `exit` is `4`. `code` is
 * `resolve-thread.ts`'s own exit, `0` when skipped.
 */
export async function resolveDeclinedThread(
  threadId: string,
  opening: { author: string | null; body: string | null } | undefined,
  timeoutSec: number,
  outcome: string,
): Promise<{ code: number; exit: 0 | 4 }> {
  const kind = outcome === "moot" ? "moot" : "declined";
  const alert = await declinedAlertOf(threadId, opening, timeoutSec);
  if (!mayResolveDeclinedAlert(alert, kind)) {
    console.error(
      kind === "moot"
        ? `triage-thread.ts: thread ${threadId}'s code scanning alert is not confirmed fixed, closed or dismissed — left open. A finding over an open alert is not moot.`
        : `triage-thread.ts: thread ${threadId}'s code scanning alert is not confirmed dismissed — left open. Dismiss it with dismiss-alert.ts, then re-run.`,
    );
    return { code: 0, exit: 4 };
  }
  const resolved = await run(tsArgv(resolveThread, [threadId]), {
    timeoutSec,
    stdout: "inherit",
    stderr: "inherit",
  });
  return { code: resolved.code, exit: 0 };
}
