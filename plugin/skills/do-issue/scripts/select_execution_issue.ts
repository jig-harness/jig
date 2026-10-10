#!/usr/bin/env bun
/**
 * Choose the next issue of an epic from its execution plan.
 *
 * Input (stdin, JSON): `{ description, epic, live, mergedConflictEdges }` —
 * the epic's description, its key, each planned issue's live state category
 * and blockers, and the merge-only conflict edges (`FROM>TO`) whose merge is
 * verified.
 * Output (JSON): `{ present, eligible, gates, mergeConflicts? }`.
 *
 * The block name comes from `do_issue.execution_plan_block` in the consumer
 * overlay (default `execution-plan-v1`).
 */
import { existsSync } from "node:fs";
import {
  overlayPath,
  readOverlay,
} from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { isEntryPoint } from "./lib/cli.ts";
import {
  DEFAULT_BLOCK,
  eligibleIssues,
  hasExecutionPlanHeading,
  humanGates,
  type LiveIssue,
  readExecutionPlan,
} from "./lib/execution-plan.ts";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** The configured block name; the default when the repository sets none. */
export function executionPlanBlock(
  overlay: Record<string, unknown> | null = existsSync(overlayPath())
    ? readOverlay()
    : null,
): string {
  const section = overlay?.do_issue;
  if (section === undefined || section === null) return DEFAULT_BLOCK;
  if (typeof section !== "object" || Array.isArray(section))
    throw new Error("do_issue must be a mapping");
  const block = (section as Record<string, unknown>).execution_plan_block;
  if (block === undefined || block === null) return DEFAULT_BLOCK;
  if (typeof block !== "string" || !/^[A-Za-z0-9][\w.-]*$/.test(block))
    throw new Error(
      "do_issue.execution_plan_block must be a fenced-block name such as execution-plan-v1",
    );
  return block;
}

export function selectExecutionIssue(
  input: {
    description: string;
    epic: string;
    live: Record<string, LiveIssue>;
    mergedConflictEdges: string[];
  },
  block = DEFAULT_BLOCK,
) {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.description !== "string" ||
    !KEY.test(input.epic) ||
    typeof input.live !== "object" ||
    input.live === null ||
    Array.isArray(input.live) ||
    !Array.isArray(input.mergedConflictEdges) ||
    !input.mergedConflictEdges.every(
      (e) =>
        typeof e === "string" &&
        /^[A-Z][A-Z0-9]*-\d+>[A-Z][A-Z0-9]*-\d+$/.test(e),
    )
  )
    throw new Error("Malformed execution selection input");
  for (const [issue, live] of Object.entries(input.live)) {
    if (
      !KEY.test(issue) ||
      typeof live !== "object" ||
      live === null ||
      ![
        "triage",
        "backlog",
        "unstarted",
        "started",
        "completed",
        "canceled",
      ].includes(live.state) ||
      !Array.isArray(live.blockedBy) ||
      !live.blockedBy.every(
        (id: unknown) => typeof id === "string" && KEY.test(id),
      )
    )
      throw new Error("Malformed live issue state or blockers");
  }
  const plan = readExecutionPlan(input.description, block);
  if (plan === null) {
    if (hasExecutionPlanHeading(input.description))
      throw new Error(
        `Execution Plan lacks a ${block} block; re-run the planner that wrote it`,
      );
    return { present: false, eligible: [], gates: [] };
  }
  if (plan.epic !== input.epic)
    throw new Error("Execution plan belongs to a different epic");
  return {
    present: true,
    eligible: eligibleIssues(plan, input.live, input.mergedConflictEdges),
    gates: humanGates(plan),
    mergeConflicts: plan.edges.filter((e) => e.completion === "merged"),
  };
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

if (isEntryPoint(import.meta.url)) {
  readStdin()
    .then((text) => {
      console.log(
        JSON.stringify(
          selectExecutionIssue(JSON.parse(text), executionPlanBlock()),
        ),
      );
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
