/**
 * The CI hold's live check for a required check whose workflow never ran on
 * the head (`missing-required-run.ts`): read what the head's runs and the
 * repository's workflow files say, and park the drive for a person when the
 * check is missing past the grace. Its forge reads, made only when a required
 * check has no check run on the head, are the head's commit statuses and its
 * workflow runs: one paginated request each, no GraphQL points.
 */
import type { ParkedDecision } from "../../../../shared/decisions/park.ts";
import { currentMs, parseMs } from "../../../../shared/time.ts";
import { testPacing } from "./cli.ts";
import type { CheckRunLite } from "./ci-hold.ts";
import {
  describeMissing,
  headPushedMs,
  MISSING_RUN_GRACE_MS,
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

async function gitText(args: string[]): Promise<string | null> {
  const r = await git(args, {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  return r.code === 0 ? r.stdout : null;
}

/** The head commit's committer date, `null` when the tree cannot say. */
async function committedMs(head: string): Promise<number | null> {
  const out = await gitText(["show", "-s", "--format=%cI", head]);
  if (out === null) return null;
  const ms = parseMs(out.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Whether the commits from `head` to the local HEAD change a workflow file. */
async function changesWorkflows(head: string): Promise<boolean> {
  const out = await gitText([
    "diff",
    "--name-only",
    head,
    "HEAD",
    "--",
    WORKFLOWS_DIR,
  ]);
  return out !== null && out.trim() !== "";
}

/** The workflow files `head` holds, as many as are read; none when the tree cannot say. */
async function workflowFiles(head: string): Promise<WorkflowFile[]> {
  const listing = await gitText([
    "ls-tree",
    "--name-only",
    head,
    `${WORKFLOWS_DIR}/`,
  ]);
  if (listing === null) return [];
  const paths = listing
    .split("\n")
    .filter((path) => /\.ya?ml$/.test(path))
    .slice(0, MAX_WORKFLOW_FILES);
  const files: WorkflowFile[] = [];
  for (const path of paths) {
    const text = await gitText(["show", `${head}:${path}`]);
    if (text !== null) files.push({ path, text });
  }
  return files;
}

/** The decision a person makes for checks that never ran on `head`. */
export function missingRunDecision(
  head: string,
  named: readonly string[],
  graceMs: number,
): ParkedDecision {
  const listed = named.slice(0, NAMED_CHECKS).join(", ");
  const more =
    named.length > NAMED_CHECKS
      ? ` and ${named.length - NAMED_CHECKS} more`
      : "";
  const minutes = Math.round(graceMs / 60_000);
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question: `How should the required check ${listed}${more}, which has no run on head ${head.slice(0, 12)}, be made to run?`,
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
      "Find the workflow named for each check; where it is unknown, find the workflow whose job reports that check.",
      "Answer in a pull-request comment and re-arm the drive.",
    ],
    alreadyDone: `The drive found that more than ${minutes} minutes passed since the head's push, found no queued or running workflow run that could still report the check, and named its workflow where the repository's workflow files identify it.`,
  };
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
  if (statuses === null || !workflowRuns.ok) {
    console.error(
      `ci-hold: a required check has no run on this head, and its ${statuses === null ? "commit statuses" : "workflow runs"} cannot be read; waiting`,
    );
    return "wait";
  }
  const graceMs = testPacing(
    "DRIVE_PR_MISSING_RUN_GRACE_MS",
    MISSING_RUN_GRACE_MS,
    0,
  );
  const verdict = missingRequiredRuns({
    runs,
    statuses,
    workflowRuns: workflowRuns.value,
    required,
    head,
    pushedMs: headPushedMs(
      runs,
      workflowRuns.value,
      head,
      await committedMs(head),
    ),
    nowMs: currentMs(),
    graceMs,
  });
  if (verdict.kind === "none") {
    await clearParkedFinding(pr, MISSING_RUN_PARK_KEY);
    return "none";
  }
  if (verdict.kind === "wait") {
    console.error(
      `ci-hold: required check(s) ${verdict.checks.map((c) => `'${c}'`).join(", ")} have no run on this head yet; ${verdict.reason}`,
    );
    return "wait";
  }
  if (await changesWorkflows(head)) {
    console.error(
      `ci-hold: required check(s) ${verdict.checks.map((c) => `'${c}'`).join(", ")} never ran on this head, and the commits about to be pushed change ${WORKFLOWS_DIR}; pushing unheld so the change can start them`,
    );
    return "workflow-change";
  }
  const files = await workflowFiles(head);
  const named = verdict.checks.map((check) =>
    describeMissing(check, workflowForCheck(check, files)),
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
