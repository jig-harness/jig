/**
 * The CI hold's live check for a required check whose workflow never ran on
 * the head (`missing-required-run.ts`): read what the head's runs and the
 * repository's workflow files say, and park the drive for a person when the
 * check is missing past the grace. Its forge reads, made only when a required
 * check has no check run on the head, are the head's commit statuses, its
 * workflow runs and its check runs again: one paginated request each, no
 * GraphQL points. The check runs are read after the workflow runs, so a job
 * a finished workflow run created is in them.
 */
import type { ParkedDecision } from "../../../../shared/decisions/park.ts";
import { currentMs } from "../../../../shared/time.ts";
import { testPacing } from "./cli.ts";
import type { CheckRunLite } from "./ci-hold.ts";
import { readCheckRuns } from "./ci-hold-state.ts";
import {
  describeMissing,
  type MissingRunVerdict,
  MISSING_RUN_GRACE_MS,
  MISSING_RUN_SETTLE_MS,
  MISSING_RUN_PARK_KEY,
  missingRequiredRuns,
  requiredWithoutAnyRun,
  type WorkflowFile,
  workflowForCheck,
} from "./missing-required-run.ts";
import { git, gitCallTimeoutSeconds } from "./proc.ts";
import { clearParkedFinding, parkFinding } from "./state/park-finding.ts";
import { commitStatusesFor } from "./status/evidence.ts";
import { readWorkflowRuns } from "./status/workflow-runs.ts";

/** Where a repository keeps its GitHub Actions workflows. */
const WORKFLOWS_DIR = ".github/workflows";

/** The most workflow files read to identify a check's workflow. */
const MAX_WORKFLOW_FILES = 100;

/** The most missing checks the question names one by one. */
const NAMED_CHECKS = 3;

/**
 * What the check found: `none` missing, `wait` for a run that may yet come,
 * `parked` for a person, or `workflow-change` when the commits about to be
 * pushed change the workflows, so the push itself may bring the run.
 */
export type MissingRunAnswer = "none" | "wait" | "parked" | "workflow-change";

/** A git command's output, `null` after saying why it failed. */
async function gitText(args: string[]): Promise<string | null> {
  const r = await git(args, {
    stderr: "pipe",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (r.code === 0) return r.stdout;
  console.error(
    `ci-hold: git ${args[0]} exited ${r.code}: ${r.stderrTail.trim()}`,
  );
  return null;
}

/** Whether the commits from `head` to the local HEAD change a workflow file; `null` when the diff cannot be read. */
async function changesWorkflows(head: string): Promise<boolean | null> {
  const out = await gitText([
    "diff",
    "--name-only",
    head,
    "HEAD",
    "--",
    WORKFLOWS_DIR,
  ]);
  return out === null ? null : out.trim() !== "";
}

/**
 * The workflow files `head` holds, as many as are read, and whether that is
 * every one: a census that stopped at the cap or failed to read a file
 * cannot say a workflow is the only one reporting a check.
 */
async function workflowFiles(
  head: string,
): Promise<{ files: WorkflowFile[]; complete: boolean }> {
  const listing = await gitText([
    "ls-tree",
    "--name-only",
    head,
    `${WORKFLOWS_DIR}/`,
  ]);
  if (listing === null) return { files: [], complete: false };
  const all = listing.split("\n").filter((path) => /\.ya?ml$/.test(path));
  let complete = all.length <= MAX_WORKFLOW_FILES;
  const files: WorkflowFile[] = [];
  for (const path of all.slice(0, MAX_WORKFLOW_FILES)) {
    const text = await gitText(["show", `${head}:${path}`]);
    if (text === null) complete = false;
    else files.push({ path, text });
  }
  return { files, complete };
}

/** The decision a person makes for checks that never ran on `head`. */
export function missingRunDecision(
  head: string,
  named: readonly string[],
  graceMs: number,
): ParkedDecision {
  const listed = named.slice(0, NAMED_CHECKS).join(", ");
  const everyCheck = named.length > NAMED_CHECKS;
  const more = everyCheck ? ` and ${named.length - NAMED_CHECKS} more` : "";
  const subject =
    named.length === 1
      ? `the required check ${listed}, which has`
      : `the required checks ${listed}${more}, which have`;
  const minutes = Math.round(graceMs / 60_000);
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question: `How should ${subject} no run on head ${head.slice(0, 12)}, be made to run?`,
      options: [
        {
          id: "repair",
          name: "Repair the workflow",
          summary:
            "Change the workflow's triggers or path filters so it runs on this pull request's head, then re-arm the drive.",
          pay: ["A workflow change before the drive goes on."],
        },
        {
          id: "manual",
          name: "Start the run by hand",
          summary:
            "Start the workflow on the head by hand, then re-arm the drive; it waits for the run's result.",
          pay: [
            "The trigger gap stays, so a later head can miss the check again.",
          ],
        },
      ],
      recommended: "repair",
      why: "A check no event starts on this head stays missing on later heads until its workflow's triggers change.",
    },
    steps: [
      ...(everyCheck ? [`The missing checks: ${named.join("; ")}.`] : []),
      "Find the workflow named for each check; where it is unknown, find the workflow whose job reports that check.",
      "Answer in a pull-request comment and re-arm the drive.",
    ],
    alreadyDone: `The drive found that more than ${minutes} minutes passed since the head's push and that no workflow run on it was queued, running or recently finished that could still report the check, and named its workflow where the repository's workflow files identify it.`,
  };
}

type ReadOutcome =
  | { ok: true }
  | { ok: false; failure: { code: string; reason: string } };

/** Which of the head's reads failed, for the line that says the drive waits; `null` when all read. */
function unreadReason(
  statuses: unknown,
  workflowRuns: ReadOutcome,
  checkRuns: ReadOutcome,
): string | null {
  if (statuses === null)
    return "its commit statuses cannot be read (the status read keeps no cause)";
  if (!workflowRuns.ok)
    return `its workflow runs cannot be read (${workflowRuns.failure.code}: ${workflowRuns.failure.reason})`;
  if (!checkRuns.ok)
    return `its check runs cannot be read again (${checkRuns.failure.code}: ${checkRuns.failure.reason})`;
  return null;
}

/** What to answer while the missing checks are not yet a park: wait, or push unheld to let a workflow change start them; `null` to park. */
async function answerBeforeParking(
  verdict: Exclude<MissingRunVerdict, { kind: "none" }>,
  head: string,
): Promise<MissingRunAnswer | null> {
  const changes = await changesWorkflows(head);
  const named = verdict.checks.map((c) => `'${c}'`).join(", ");
  if (verdict.kind === "wait" && changes !== true) {
    console.error(
      `ci-hold: required check(s) ${named} have no run on this head yet; ${verdict.reason}`,
    );
    return "wait";
  }
  if (changes === null) {
    console.error(
      `ci-hold: required check(s) ${named} never ran on this head, and whether the commits about to be pushed change ${WORKFLOWS_DIR} cannot be read; waiting`,
    );
    return "wait";
  }
  if (!changes) return null;
  console.error(
    `ci-hold: required check(s) ${named} never ran on this head, and the commits about to be pushed change ${WORKFLOWS_DIR}; pushing unheld so the change can start them`,
  );
  return "workflow-change";
}

/**
 * Whether a required check has no run on `head` past the grace, and the
 * drive is parked for it. `runs` are the head's check runs, already read.
 * A read that fails waits: nothing is parked on evidence that did not read.
 */
export async function stopOnMissingRequiredRun(
  pr: string,
  head: string,
  required: readonly string[],
  runs: readonly CheckRunLite[],
): Promise<MissingRunAnswer> {
  if (requiredWithoutAnyRun(runs, [], required, head).length === 0) {
    await clearParkedFinding(pr, MISSING_RUN_PARK_KEY);
    return "none";
  }
  const [statuses, workflowRuns] = await Promise.all([
    commitStatusesFor("{owner}", "{repo}", head),
    readWorkflowRuns("{owner}", "{repo}", head),
  ]);
  const checkRuns = await readCheckRuns(head);
  const unread = unreadReason(statuses, workflowRuns, checkRuns);
  if (unread !== null) {
    console.error(
      `ci-hold: a required check has no run on this head, and ${unread}; waiting`,
    );
    return "wait";
  }
  if (statuses === null || !workflowRuns.ok || !checkRuns.ok) return "wait";
  const graceMs = testPacing(
    "DRIVE_PR_MISSING_RUN_GRACE_MS",
    MISSING_RUN_GRACE_MS,
    0,
  );
  const verdict = missingRequiredRuns({
    runs: checkRuns.value,
    statuses,
    workflowRuns: workflowRuns.value,
    required,
    head,
    nowMs: currentMs(),
    graceMs,
    settleMs: testPacing(
      "DRIVE_PR_MISSING_RUN_SETTLE_MS",
      MISSING_RUN_SETTLE_MS,
      0,
    ),
  });
  if (verdict.kind === "none") {
    await clearParkedFinding(pr, MISSING_RUN_PARK_KEY);
    return "none";
  }
  const early = await answerBeforeParking(verdict, head);
  if (early !== null) return early;
  const { files, complete } = await workflowFiles(head);
  const named = verdict.checks.map((check) =>
    describeMissing(check, complete ? workflowForCheck(check, files) : null),
  );
  console.error(
    `ci-hold: required check(s) ${named.join(", ")} have no run on this head ${Math.round(graceMs / 60_000)} minutes after its push, and no workflow run on it is still to finish; parking ${MISSING_RUN_PARK_KEY} for a person`,
  );
  await parkFinding(
    pr,
    MISSING_RUN_PARK_KEY,
    missingRunDecision(head, named, graceMs),
  );
  return "parked";
}
