import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import { isRateLimited } from "../../../shared/outbound/budget.ts";
/** Occupancy is read independently of who may authorize a pickup. */
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import type { ServedView } from "./served-reads.ts";
import { metadata, type Metadata } from "./served-metadata.ts";
import { servedParentSteps } from "./served-parents.ts";
import { itemFailed } from "./served-failures.ts";
import { servedPlan } from "./served-plan.ts";
import type { Candidate } from "./served-admission.ts";
import { takeUnreadSlot, type Serial } from "./served-epics.ts";
import type { Found, ServedOptions } from "./served.ts";

export function occupancyMetadata(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  view: ServedView,
): Promise<Metadata> {
  return metadata(
    tracker,
    { ...issue, assignee: null },
    "",
    cache,
    view.held(issue.identifier)?.relations ?? null,
    view,
  );
}

/** Each unknown branch reserves one direct slot, including a cycle or excessive depth. */
async function occupiedBranch(
  issue: PoolIssue,
  inspect: (
    issue: PoolIssue,
  ) => Promise<{ children: PoolIssue[]; unread: string[] }>,
  parked: (issue: PoolIssue) => boolean,
  failed: (error: unknown) => void,
  path: ReadonlySet<string> = new Set(),
): Promise<"busy" | "free" | "unknown"> {
  if (parked(issue)) return "free";
  if (issue.state.type === "started") return "busy";
  if (!issue.isEpic || !issue.hasOpenChildren) return "free";
  if (path.has(issue.identifier) || path.size >= 100) return "unknown";
  const read = await inspect(issue);
  if (read.unread.length > 0) return "unknown";
  if (read.children.length === 0) return "unknown";
  const next = new Set(path).add(issue.identifier);
  const results = await Promise.allSettled(
    read.children.map((c) => occupiedBranch(c, inspect, parked, failed, next)),
  );
  return occupancyResults(results, failed);
}

/** Keep a tracker wall ahead of ordinary branch failures after every read settles. */
function occupancyResults(
  results: PromiseSettledResult<"busy" | "free" | "unknown">[],
  note: (error: unknown) => void,
): "busy" | "free" | "unknown" | Promise<never> {
  const failures = results.filter((r) => r.status === "rejected");
  const failed =
    failures.find((r) => isRateLimited(r.reason)) ??
    failures.find((r) => isUnavailable(r.reason)) ??
    failures[0];
  for (const other of failures.filter((r) => r !== failed)) {
    if (!isWall(other.reason)) note(other.reason);
  }
  if (failed?.status === "rejected") return Promise.reject(failed.reason);
  const states = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  if (states.includes("unknown")) return "unknown";
  return states.includes("busy") ? "busy" : "free";
}

export async function attachAdmissions(
  ctx: {
    tracker: Tracker;
    cache: PickupReads;
    view: ServedView;
    options: ServedOptions;
    serials: Map<string, Serial>;
  },
  candidate: Candidate,
  found: Found,
  setupParent: (parent: PoolIssue, meta: Metadata) => Promise<void>,
): Promise<string | null> {
  const { tracker, cache, view, options } = ctx;
  const steps = await servedParentSteps(tracker, candidate.issue, cache, view);
  if (steps === null) {
    itemFailed(found);
    return "the epic ancestry cannot be read";
  }
  candidate.admissions = [];
  for (const step of steps) {
    if (
      servedPlan(
        step.description,
        step.parent.identifier,
        {},
        options.executionPlanBlock,
      ).present
    )
      continue;
    if (!ctx.serials.has(step.child)) {
      const meta = await occupancyMetadata(tracker, step.parent, cache, view);
      if (meta.children.length === 0) {
        if (!step.parent.hasOpenChildren) continue;
        found.partial = true;
        return "the parent reports open children but its children cannot be read";
      }
      await setupParent(step.parent, meta);
    }
    const serial = ctx.serials.get(step.child);
    if (serial !== undefined)
      candidate.admissions.push({ serial, child: step.child });
  }
  return null;
}

/** An unread started child still proves work; a plan preserves its own human holds. */
export function anyWorking(
  children: PoolIssue[],
  parked: PoolIssue[],
  busy: string[],
): boolean {
  return (
    busy.length > 0 ||
    children.some(
      (child) => child.state.type === "started" && !parked.includes(child),
    )
  );
}

/** Inspect one branch; a failed read consumes that branch's one parent slot. */
async function reserveBranch(
  child: PoolIssue,
  inspect: (
    issue: PoolIssue,
  ) => Promise<{ children: PoolIssue[]; unread: string[] }>,
  parked: (issue: PoolIssue) => boolean,
  unread: string[],
  note: (child: PoolIssue, error?: unknown) => void,
  failed: (error: unknown) => void,
): Promise<"busy" | "free" | "unknown"> {
  try {
    const state = await occupiedBranch(child, inspect, parked, failed);
    if (state === "unknown") {
      unread.push(child.identifier);
      note(child);
    }
    return state;
  } catch (error) {
    await takeUnreadSlot(unread, child.identifier, error, (cause) =>
      note(child, cause),
    );
    return "unknown";
  }
}

export async function occupancySlots(
  children: PoolIssue[],
  unread: string[],
  inspect: (
    issue: PoolIssue,
  ) => Promise<{ children: PoolIssue[]; unread: string[] }>,
  parked: (issue: PoolIssue) => boolean,
  note: (child: PoolIssue, error?: unknown) => void,
  report: { recursive: boolean; failed: (error: unknown) => void },
): Promise<string[]> {
  if (!report.recursive) return [];
  const busy: string[] = [];
  for (const child of children) {
    if (unread.includes(child.identifier)) continue;
    if (
      (await reserveBranch(
        child,
        inspect,
        parked,
        unread,
        note,
        report.failed,
      )) === "busy"
    )
      busy.push(child.identifier);
  }
  return busy;
}

function isWall(error: unknown): boolean {
  return isRateLimited(error) || isUnavailable(error);
}

/** A wall cannot discard ordinary failures already observed during setup. */
export async function withOccupancySetup(
  found: Found,
  inspect: (setup: Found) => Promise<void>,
): Promise<void> {
  const setup: Found = {
    unplaced: [],
    candidates: [],
    pending: [],
    failures: [],
    partial: false,
  };
  try {
    await inspect(setup);
  } finally {
    found.unplaced.push(...setup.unplaced);
    found.failures.push(...setup.failures);
    found.partial ||= setup.partial;
  }
}
