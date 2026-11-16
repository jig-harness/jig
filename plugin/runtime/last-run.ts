/**
 * The verdict on a component's last run, from its receipts: the check
 * `jig doctor` reports as `<component>:last-run`, and the health check the
 * dispatcher's tick reads before it runs again a stage the host failed
 * (`dispatch/lib/rerun-gate.ts`), so both say the same.
 */
import type { DoctorCheck, LastRun } from "./component.ts";

/** The failed runs in a row a failed last run ends, when there is more than the one. */
function failedRunText(failing: LastRun["failing"]): string {
  if (failing === undefined || failing.runs < 2) return "";
  return `; ${failing.capped ? "at least " : ""}${failing.runs} runs in a row have failed, since ${failing.since}`;
}

/** The last run's receipt: passes when it completed with exit 0, skipped with none yet. */
export function lastRunCheck(name: string, last: LastRun | null): DoctorCheck {
  const id = `${name}:last-run`;
  if (last === null) return { id, status: "skip", detail: "no receipt yet" };
  if (last.unread !== undefined)
    return {
      id,
      status: "fail",
      detail: `the newest ${last.unread} receipts hold no tick that ran, so the last run is unknown`,
      fix: `jig receipts ${name}`,
    };
  if (last.completed && last.exitStatus === 0)
    return { id, status: "pass", detail: `${last.runId}, exit 0` };
  const outcome = last.completed
    ? `${last.runId} exited ${last.exitStatus}`
    : `${last.runId} did not complete: it is still running, or it stopped before it finished`;
  return {
    id,
    status: "fail",
    detail: `${outcome}${last.reason === undefined ? "" : `: ${last.reason}`}${failedRunText(last.failing)}`,
    fix: `jig receipts ${name} ${last.runId}`,
  };
}
