/** GitHub's failed-job retry behind the forge interface and its governed transport. */
import { ghCall } from "../proc.ts";
import { holdLabelPolicy } from "../ci-policy.ts";
import { parsePrSnapshot } from "../ci-hold.ts";
import {
  assertRemoteMutationAllowed,
  resolveFenceContext,
} from "../state/lease.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { rerunnableRuns } from "./failed-runs.ts";
import type { RetryForge } from "./ci-attempts.ts";
import { isRecord } from "../../../../../shared/guards.ts";

async function readAttempt(head: string, id: number) {
  const run = await ghCall([
    "run",
    "view",
    String(id),
    "--json",
    "headSha,status,attempt",
  ]);
  if (run.code !== 0)
    return {
      ok: false as const,
      detail: `the run could not be read (forge exit ${run.code}): ${run.stderr.trim()}`,
    };
  const evidence: unknown = JSON.parse(run.stdout);
  if (
    !isRecord(evidence) ||
    evidence.headSha !== head ||
    !Number.isSafeInteger(evidence.attempt) ||
    Number(evidence.attempt) < 1 ||
    typeof evidence.status !== "string"
  )
    return {
      ok: false as const,
      detail: "the run's head or attempt is unreadable",
    };
  return {
    ok: true as const,
    value: {
      attempt: Number(evidence.attempt),
      completed: evidence.status === "completed",
    },
  };
}

export const failedCheckForge: RetryForge = {
  rerunnable: rerunnableRuns,
  async observe(head, id) {
    try {
      const read = await readAttempt(head, id);
      if (read.ok) return read.value;
      console.error(read.detail);
    } catch (err) {
      swallow(err, "the retry's replacement attempt is unreadable");
    }
    return null;
  },
  async retry(pr, head, id) {
    let lock: Awaited<ReturnType<typeof assertRemoteMutationAllowed>> | null =
      null;
    try {
      const fence = await resolveFenceContext("failed-check retry");
      lock =
        fence === null
          ? null
          : await assertRemoteMutationAllowed(fence, pr, "failed-check retry");
      const run = await readAttempt(head, id);
      if (!run.ok) return run;
      if (!run.value.completed)
        return {
          ok: false,
          detail: "the run is unfinished or belongs to another head",
        };
      const read = await ghCall([
        "pr",
        "view",
        pr,
        "--json",
        "state,headRefOid,labels",
      ]);
      if (read.code !== 0)
        return {
          ok: false,
          detail: `the PR could not be read (forge exit ${read.code}): ${read.stderr.trim()}`,
        };
      const snapshot = parsePrSnapshot(
        JSON.parse(read.stdout) as unknown,
        holdLabelPolicy(),
      );
      if (
        snapshot === null ||
        snapshot.state !== "OPEN" ||
        snapshot.head !== head ||
        snapshot.held
      )
        return {
          ok: false,
          detail: "the PR closed, its head changed, or CI is held",
        };
      const retry = await ghCall(["run", "rerun", String(id), "--failed"]);
      return {
        ok: retry.code === 0,
        // A transport/process failure after issuing the mutation is not proof
        // GitHub refused it; the caller must reconcile rather than repair.
        ...(retry.code === 0 ? {} : { indeterminate: true }),
        detail: retry.stderr.trim() || `forge exit ${retry.code}`,
        attempt: run.value.attempt,
      };
    } catch (err) {
      swallow(
        err,
        "failed-check retry could not establish its mutation authority or head witness",
      );
      return {
        ok: false,
        indeterminate: true,
        detail: "the mutation authority or head witness is unreadable",
      };
    } finally {
      lock?.dispose();
    }
  },
};
