import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alertNumberOf,
  isCodeScanningLogin,
  readAlert,
} from "../../../resolve-review-comments/scripts/lib/code-scanning.ts";
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

/** A declined code-scanning finding can close only after dismissal is verified. */
export function mayResolveDeclinedAlert(alert: unknown): boolean {
  if (alert === undefined) return true;
  if (typeof alert !== "object" || alert === null || Array.isArray(alert))
    return false;
  const record = alert as Record<string, unknown>;
  return record.state === "dismissed" && record.unreadable === undefined;
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
 * repository cannot be read yields `null`, which keeps it open.
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
  if (number === null) return undefined;
  return readAlert(where.owner, where.repo, number, where.pr);
}

/**
 * Resolve thread `threadId` for a merit outcome, unless it is a code-scanning
 * thread whose alert is not confirmed dismissed: then it stays open and
 * `exit` is `4`. `code` is `resolve-thread.ts`'s own exit, `0` when skipped.
 */
export async function resolveDeclinedThread(
  threadId: string,
  opening: { author: string | null; body: string | null } | undefined,
  timeoutSec: number,
): Promise<{ code: number; exit: 0 | 4 }> {
  const alert = await declinedAlertOf(threadId, opening, timeoutSec);
  if (!mayResolveDeclinedAlert(alert)) {
    console.error(
      `triage-thread.ts: thread ${threadId}'s code scanning alert is not confirmed dismissed — left open. Dismiss it with dismiss-alert.ts, then re-run.`,
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
