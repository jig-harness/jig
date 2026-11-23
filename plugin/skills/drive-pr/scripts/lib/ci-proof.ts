/** What a CI proof read answers, and the stop a check-runs listing cut short ends it with. */
import { fail } from "./cli.ts";
import type { ListingCutShort } from "./paged-read.ts";
import { DRIVE_EXIT } from "./status/terminal-states.ts";

import {
  checkRunListing,
  ciVerdictOf,
  commitStatusesFor,
  hasNonReviewerCi,
} from "./status/evidence.ts";
import { workflowRunsBehind } from "./status/workflow-runs.ts";

/** A proof read that held, or that did not and says whether its listing was cut short. */
export type ProofRead =
  | { ok: true }
  | { ok: false; cutShort?: ListingCutShort; pending?: boolean };

export const BASE_MERGE_CI_PENDING = "base-merge-ci-pending";

/** A script's stdout record of the pages a cut-short listing read, and the drive's exit for it. */
export function listingStopExit(pagesRead: number | null): number {
  process.stdout.write(`${JSON.stringify({ listingPagesRead: pagesRead })}\n`);
  return DRIVE_EXIT.CHECK_RUNS_UNREADABLE;
}

/** The page count a script's stdout record carries with a listing stop; null when it carries none. */
export function listingPagesReadFrom(stdout: string): number | null {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null) continue;
      const pages = Reflect.get(record, "listingPagesRead");
      if (typeof pages === "number") return pages;
    } catch {
      // Not the stop record.
    }
  }
  return null;
}

/** A failed read that carries its listing's classification when it has one. */
export function unreadable<T extends { reason: string }>(
  failed: T,
  cutShort: ListingCutShort | null,
): T & { ok: false; cutShort?: ListingCutShort } {
  return cutShort === null
    ? { ...failed, ok: false }
    : { ...failed, ok: false, cutShort };
}

/** Exit a command on a failed proof: the named listing stop when its listing was cut short, else `code`. */
export function exitOnProof(
  proof: { reason: string; cutShort?: ListingCutShort },
  code: number,
  message: (reason: string) => string,
): never {
  if (proof.cutShort === undefined) return fail(code, message(proof.reason));
  listingStopExit(proof.cutShort.pagesRead);
  return fail(DRIVE_EXIT.CHECK_RUNS_UNREADABLE, message(proof.cutShort.reason));
}

/** A head's check runs and commit statuses, or the refusal that read ended in. */
async function readHeadCi(head: string): Promise<
  | ProofRead
  | {
      allRuns: NonNullable<Awaited<ReturnType<typeof checkRunListing>>["runs"]>;
      statuses: NonNullable<Awaited<ReturnType<typeof commitStatusesFor>>>;
    }
> {
  const [{ runs: allRuns, cutShort }, statuses] = await Promise.all([
    checkRunListing("{owner}", "{repo}", head),
    commitStatusesFor("{owner}", "{repo}", head),
  ]);
  if (cutShort !== null) return { ok: false, cutShort };
  if (allRuns === null || statuses === null) return { ok: false };
  return { allRuns, statuses };
}

/** Strict success requires both check runs and attributed legacy statuses to be green. */
export async function requiredCiAggregateIsGreen(
  head: string,
): Promise<ProofRead> {
  const read = await readHeadCi(head);
  if ("ok" in read) return read;
  const { allRuns, statuses } = read;
  const workflowRuns = await workflowRunsBehind(
    "{owner}",
    "{repo}",
    head,
    allRuns,
  );
  const verdict = ciVerdictOf(allRuns, statuses, false, head, workflowRuns);
  return verdict === "green"
    ? { ok: true }
    : { ok: false, pending: verdict.startsWith("pending:") };
}

/** Has any non-reviewer check run or commit status registered on `head`? */
export async function anyCiOnHead(head: string): Promise<ProofRead> {
  const read = await readHeadCi(head);
  if ("ok" in read) return read;
  const { allRuns, statuses } = read;
  return hasNonReviewerCi(allRuns, statuses)
    ? { ok: true }
    : { ok: false, pending: true };
}
