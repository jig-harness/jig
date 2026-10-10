#!/usr/bin/env bun
/**
 * Fetch one issue through the consumer's tracker, with a sub-issue completion
 * analysis.
 *
 * Type: Discovery
 * Input: an issue key (e.g. ENG-123)
 * Output: JSON with the issue's details, labels, children and
 *   `sub_issue_analysis`
 *
 * Usage:
 *     bun get_issue.ts <issue-key> [--verbose]
 *
 * Exit codes: 0 found, 2 not found (or the tracker unreachable, or its
 * answer unusable), 1 unexpected error (no tracker configured).
 *
 * The tracker comes from `issue_tracker` in the consumer overlay
 * (`lib/tracker/`). Runs under Bun and under Node ≥ 22.18 (type stripping).
 */

import { isEntryPoint, parseArgs } from "./lib/cli.ts";
import { openTracker } from "./lib/tracker/index.ts";
import type { Issue, IssueState, Tracker } from "./lib/tracker/port.ts";

interface ChildOut {
  identifier: string;
  title: string;
  state: IssueState;
  labels?: Array<{ name: string }>;
}

/**
 * The state categories a tracker reports. A recognized category is
 * authoritative; the name is consulted only when the tracker gives none.
 * Exported so `reconcile_parent_status.ts` applies the same precedence.
 */
export const KNOWN_STATE_TYPES = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
]);

/**
 * The fallback's whole state names, compared exactly (case-insensitive). A
 * substring match would read "Incomplete" as complete and "Not done" as done,
 * hiding unfinished children from a parent's completion verdict; a name
 * outside these sets stays incomplete.
 */
const ABANDONED_STATE_NAMES = new Set(["canceled", "cancelled", "duplicate"]);
const COMPLETED_STATE_NAMES = new Set([
  "done",
  "complete",
  "completed",
  "finished",
  "closed",
]);

/**
 * Which completion bucket a sub-issue's state falls in.
 *
 * `abandoned` (canceled, duplicate) is terminal but not delivered: such a
 * child will never complete, so counting it as incomplete would keep
 * `all_complete` false forever on any parent that cancelled a child.
 *
 * Category first, name second. Once the category is recognized it alone
 * decides; a state named "Canceled Backlog Items" whose category is
 * `completed` is done. Name patterns are the fallback for a tracker answer
 * that carries no category.
 */
export function classifyChildState(
  state: Partial<IssueState> | undefined,
): "completed" | "abandoned" | "incomplete" {
  const type = (state?.type ?? "").toLowerCase();
  if (KNOWN_STATE_TYPES.has(type)) {
    if (type === "canceled" || type === "duplicate") return "abandoned";
    if (type === "completed") return "completed";
    return "incomplete";
  }
  const name = (state?.name ?? "").trim().toLowerCase();
  if (ABANDONED_STATE_NAMES.has(name)) return "abandoned";
  if (COMPLETED_STATE_NAMES.has(name)) return "completed";
  return "incomplete";
}

/** The script's JSON answer for one issue. */
export function issueResult(issue: Issue): Record<string, unknown> {
  // Child labels keep the `{ name }` shape `reconcile_parent_status.ts` reads.
  const children: ChildOut[] = issue.children.map((c) => ({
    identifier: c.identifier,
    title: c.title,
    state: c.state,
    ...(c.labels === undefined
      ? {}
      : { labels: c.labels.map((name) => ({ name })) }),
  }));
  const result: Record<string, unknown> = {
    found: true,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
    state: {
      name: issue.state.name || "Unknown",
      type: issue.state.type || "unknown",
    },
    labels: issue.labels,
    url: issue.url,
    parent: issue.parent,
    children,
    assignee: issue.assignee,
    project: issue.project,
  };

  if (children.length > 0) {
    const completed: ChildOut[] = [];
    const abandoned: ChildOut[] = [];
    const incomplete: ChildOut[] = [];
    for (const child of children) {
      const bucket = classifyChildState(child.state);
      if (bucket === "completed") completed.push(child);
      else if (bucket === "abandoned") abandoned.push(child);
      else incomplete.push(child);
    }
    // The denominator is the work that could still complete: abandoned
    // children count in neither the numerator nor the denominator.
    const eligible = children.length - abandoned.length;
    result.sub_issue_analysis = {
      total: children.length,
      completed: completed.length,
      abandoned: abandoned.length,
      incomplete: incomplete.length,
      progress_percent:
        eligible === 0 ? 100 : Math.round((completed.length / eligible) * 100),
      completed_issues: completed,
      abandoned_issues: abandoned,
      incomplete_issues: incomplete,
      next_issue: incomplete[0] ?? null,
      all_complete: incomplete.length === 0,
    };
  } else {
    result.sub_issue_analysis = { total: 0, has_sub_issues: false };
  }
  return result;
}

function notFound(issueId: string, why: string): Record<string, unknown> {
  return {
    error: `Issue ${issueId} not found${why === "" ? "" : `: ${why}`}`,
    found: false,
    suggestions: [
      "Check the key format (e.g. ENG-123, not just 123)",
      "Check issue_tracker.team in .config/groundwork-overlay.yaml",
      "Use the tracker's own integration (Linear: the get_issue MCP tool)",
    ],
  };
}

/**
 * Fetch one issue. An issue the tracker does not have, an answer whose shape
 * cannot be read, and a tracker that cannot be reached are all reported as
 * not found, with the reason: the caller's next step is the same (fall back
 * to the tracker's own integration, or stop), and an unusable answer must
 * never read as a found issue with empty fields.
 */
export async function getIssue(
  issueId: string,
  tracker: Tracker = openTracker(),
): Promise<Record<string, unknown>> {
  let issue: Issue | null;
  try {
    issue = await tracker.getIssue(issueId);
  } catch (err) {
    return notFound(issueId, err instanceof Error ? err.message : String(err));
  }
  return issue === null ? notFound(issueId, "") : issueResult(issue);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: ["verbose"],
    values: [],
    usage: "usage: get_issue.ts <issue-key> [--verbose]",
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const verbose = parsed.args.flags.has("verbose");
  const issueId = parsed.args.positional;

  try {
    if (verbose) console.error(`Fetching issue: ${issueId}`);
    const result = await getIssue(issueId);
    if (verbose) {
      if (result.found === true) {
        console.error(`Found: ${String(result.title)}`);
        const analysis = result.sub_issue_analysis as
          | { total?: number; completed?: number; abandoned?: number }
          | undefined;
        if ((analysis?.total ?? 0) > 0) {
          // Same denominator as progress_percent: abandoned children excluded.
          const eligible = (analysis?.total ?? 0) - (analysis?.abandoned ?? 0);
          console.error(
            `Sub-issues: ${analysis?.completed}/${eligible} complete`,
          );
        }
      } else {
        console.error(`Not found: ${String(result.error)}`);
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return result.found === true ? 0 : 2;
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    if (verbose && e instanceof Error) console.error(e.stack);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
