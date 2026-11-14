/** Retry and repair allowances belong to an exact head and a named failing check. */
import type { FailingChecks } from "./infra-recovery.ts";
import { failedRunsField, failedStatusesField } from "./failed-runs.ts";
import type { FailedRun } from "../status/workflow-runs.ts";

export interface CiAttempts {
  repairs: Map<string, number>;
  retries: Set<string>;
  pending: Map<
    string,
    { head: string; run: number; attempt: number; polls: number }
  >;
}

export const attemptState = (): CiAttempts => ({
  repairs: new Map(),
  retries: new Set(),
  pending: new Map(),
});
export function attemptsFor(context: { ciAttempts?: CiAttempts }): CiAttempts {
  context.ciAttempts ??= attemptState();
  return context.ciAttempts;
}
const key = (head: string, name: string) => JSON.stringify([head, name]);
const namesOf = (failing: FailingChecks): string[] => [
  ...new Set([
    ...(failing.checkRunNames ?? []),
    ...(failing.statusNames ?? []),
  ]),
];

/** Keep the repair's structured inputs aligned with the checks it may charge. */
export function repairSelection(
  head: string,
  failing: FailingChecks,
  state: CiAttempts,
  budget: number,
) {
  const all = namesOf(failing);
  // An unreadable structured list keeps the older bounded repair path.
  const counted = all.length === 0 ? ["<unnamed checks>"] : all;
  const names = counted.filter(
    (name) => (state.repairs.get(key(head, name)) ?? 0) < budget,
  );
  const used = Math.max(
    0,
    ...(names.length > 0 ? names : counted).map(
      (name) => state.repairs.get(key(head, name)) ?? 0,
    ),
  );
  const selected: FailingChecks =
    all.length === 0
      ? failing
      : {
          ...failing,
          checkRunNames:
            failing.checkRunNames?.filter((n) => names.includes(n)) ?? null,
          statusNames:
            failing.statusNames?.filter((n) => names.includes(n)) ?? null,
          runs: failedRunsField(failing.runs).filter(
            (r) =>
              Array.isArray(r.jobNames) &&
              r.jobNames.some((n) => names.includes(n)),
          ),
          statuses: failedStatusesField(failing.statuses).filter((s) =>
            names.includes(s.context),
          ),
        };
  return { names, used, failing: selected };
}

/** Charge only after a repair pass actually dispatched. */
export function chargeRepair(
  head: string,
  failing: FailingChecks,
  state: CiAttempts,
): string[] {
  const names = namesOf(failing);
  return (names.length === 0 ? ["<unnamed checks>"] : names).map((name) => {
    const id = key(head, name);
    const spent = (state.repairs.get(id) ?? 0) + 1;
    state.repairs.set(id, spent);
    return `${name}: pass ${spent}`;
  });
}

/** Forge adapter: the driver never depends on a vendor's retry command. */
export interface RetryForge {
  rerunnable(pr: string, runs: readonly FailedRun[]): Promise<number[]>;
  /** Verify an open, unheld PR and this run's exact head immediately before retrying. */
  retry(
    pr: string,
    head: string,
    run: number,
  ): Promise<{ ok: boolean; detail: string; attempt?: number }>;
  observe(
    head: string,
    run: number,
  ): Promise<{ attempt: number; completed: boolean } | null>;
}

/** Retry each safe workflow once. A shared workflow cannot repeat an already retried check. */
export async function retryFailedChecks(
  pr: string,
  head: string,
  failing: FailingChecks,
  state: CiAttempts,
  forge: RetryForge,
  record: (detail: string) => Promise<void>,
): Promise<boolean> {
  const names = failing.checkRunNames;
  if (names === null || failing.statusNames === null || names.length === 0)
    return false;
  const runs = failedRunsField(failing.runs).filter(
    (run) =>
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Array.isArray(run.jobNames) &&
      run.jobNames.length > 0 &&
      run.jobNames.every(
        (name) => names.includes(name) && !state.retries.has(key(head, name)),
      ),
  );
  const allowed = await forge.rerunnable(pr, runs);
  let retried = false;
  for (const run of runs) {
    if (!allowed.includes(run.id)) continue;
    const jobs = run.jobNames ?? [];
    // Re-check after earlier workflows: duplicated provenance must not retry a check twice.
    if (jobs.some((name) => state.retries.has(key(head, name)))) continue;
    for (const name of jobs) state.retries.add(key(head, name));
    const answer = await forge.retry(pr, head, run.id);
    if (answer.ok)
      state.pending.set(key(head, String(run.id)), {
        head,
        run: run.id,
        attempt: answer.attempt ?? 1,
        polls: 0,
      });
    const detail = answer.ok
      ? `Re-ran failed jobs of run ${run.id} on head ${head} for ${jobs.join(", ")} (retry 1/1, no repair pass spent).`
      : `Retry of run ${run.id} on head ${head} refused: ${answer.detail}.`;
    console.error(`  ${detail}`);
    await record(detail);
    retried ||= answer.ok;
  }
  return retried;
}
