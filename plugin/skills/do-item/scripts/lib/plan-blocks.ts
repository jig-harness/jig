/**
 * Write an epic's execution-plan dependency edges to the tracker as native
 * `blocks` relations.
 *
 * The plan keeps its edges (the format contract in `execution-plan.ts`), and
 * the tracker's own `blocks` is where a person, a board and the dispatcher
 * read what waits for what. A planner runs this after it writes the plan, so
 * a dependency is stated in both places and the reader can refuse a plan the
 * tracker contradicts. Conflict edges have no native form and stay in the
 * plan.
 */

import {
  DEFAULT_BLOCK,
  hasExecutionPlanHeading,
  readExecutionPlan,
} from "./execution-plan.ts";
import { type Tracker, TrackerRequestError } from "./tracker/port.ts";

export interface PlanBlocks {
  /** The plan has a block to read. */
  present: boolean;
  /** `from blocks to` written (or, on a dry run, to write). */
  written: Array<{ from: string; to: string }>;
  /** Dependency edges the tracker already had. */
  existing: Array<{ from: string; to: string }>;
}

type Edge = { from: string; to: string };

/** The plan's dependency edges, or `null` when the epic has no plan block. */
async function planDependencies(
  tracker: Pick<Tracker, "getIssue">,
  epic: string,
  block: string | undefined,
): Promise<Edge[] | null> {
  const issue = await tracker.getIssue(epic);
  if (issue === null)
    throw new TrackerRequestError("unresolved", `issue ${epic} does not exist`);
  const plan = readExecutionPlan(issue.description ?? "", block);
  if (plan === null) {
    if (hasExecutionPlanHeading(issue.description ?? ""))
      throw new TrackerRequestError(
        "invalid",
        `Execution Plan lacks a ${block ?? DEFAULT_BLOCK} block; re-run the planner that wrote it`,
      );
    return null;
  }
  if (plan.epic !== issue.identifier)
    throw new TrackerRequestError(
      "invalid",
      "Execution plan belongs to a different epic",
    );
  return plan.edges.filter((e) => e.kind === "dependency");
}

export async function syncPlanBlocks(
  tracker: Pick<Tracker, "getIssue" | "listRelations" | "relate">,
  epic: string,
  opts: { block?: string; dryRun?: boolean } = {},
): Promise<PlanBlocks> {
  const edges = await planDependencies(tracker, epic, opts.block);
  const report: PlanBlocks = {
    present: edges !== null,
    written: [],
    existing: [],
  };
  if (edges === null) return report;
  // Refuse every contradiction before the first write, so a rejected request
  // leaves the tracker as it was.
  const missing: Edge[] = [];
  for (const { from, to } of edges) {
    const own = await tracker.listRelations(from);
    if (own.some((r) => r.type === "blocked_by" && r.issue === to))
      throw new TrackerRequestError(
        "invalid",
        `the plan says ${from} blocks ${to}, but the tracker says ${to} blocks ${from}; remove the wrong side first`,
      );
    if (own.some((r) => r.type === "blocks" && r.issue === to))
      report.existing.push({ from, to });
    else missing.push({ from, to });
  }
  for (const { from, to } of missing) {
    if (opts.dryRun !== true) await tracker.relate(from, "blocks", to);
    report.written.push({ from, to });
  }
  return report;
}
