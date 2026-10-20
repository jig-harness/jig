/**
 * The live record of resolved conflicts: one `merge_conflict` event per
 * conflicted path, appended as a line of JSON to
 * `$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl` when the
 * operation the snapshot describes has concluded. All worktrees of a clone
 * share the file and nothing commits it. A rebase, a cherry-pick and a revert
 * leave nothing else a replay could read.
 *
 * One conflict is one record, identified by the commit the operation
 * concluded with and its path, so recording twice (the script after the
 * conclusion, and the next map flushing what an earlier one left) counts once.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";
import { errnoCode, swallow } from "../../../../shared/errors.ts";
import type { Cause } from "./causes.ts";
import { commonDir, git, gitRaw } from "./git.ts";
import { type PathCauses, snapshotCauses } from "./live-causes.ts";
import type { OperationKind } from "./operation.ts";
import type { Snapshot } from "./snapshot.ts";

export const EVENT_TYPE = "merge_conflict";
export const EVENTS_FILE = "conflict-events.jsonl";

/** What started the resolution, when the environment says. */
export type EventSource = "drive-pr" | "session";

export interface MergeConflictEvent {
  type: typeof EVENT_TYPE;
  /** When the operation concluded: the committer date of `commit`. */
  ts: string;
  operation: OperationKind;
  path: string;
  /** The cause that stands for the path (`primaryCause`). */
  cause: Cause;
  /** The causes of its regions, or its one path-level cause. */
  causes: Cause[];
  /** How many conflicting regions the path had; 0 without text regions. */
  regions: number;
  decision: string | null;
  reason: string | null;
  /** Milliseconds from the last map to the conclusion. */
  resolution_ms: number | null;
  source: EventSource;
  /** The commit the operation concluded with. */
  commit: string;
  /** The pull request being driven, when the resolution ran inside a drive. */
  pr: number | null;
  /** The branch the operation ran on, when it was on one. */
  branch: string | null;
  /** The two sides as git names them for the operation (a rebase's `ours` is its upstream). */
  ours_commit: string;
  ours_ref: string | null;
  theirs_commit: string;
  theirs_ref: string | null;
}

/**
 * The commit a snapshot's operation concluded with, or null when it has not,
 * or when a commit above its `HEAD` is not the operation's own: an aborted
 * operation leaves its snapshot behind, and the next ordinary commit must not
 * be taken for its conclusion.
 */
export function concludedCommit(
  root: string,
  snapshot: Snapshot,
): string | null {
  const { kind, head, incoming } = snapshot.operation;
  const first = gitRaw(root, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${head}..HEAD`,
  ]);
  const commit = first.code === 0 ? first.stdout.split("\n")[0]?.trim() : "";
  if (commit) {
    const parents = parentsOf(root, commit);
    if (
      parents?.[0] === head &&
      belongsTo(root, kind, incoming, commit, parents)
    )
      return commit;
  }
  return kind === "rebase" ? amendedCommit(root, head, incoming) : null;
}

/** The parents of `commit`, or null when git cannot say. */
function parentsOf(root: string, commit: string): string[] | null {
  const r = gitRaw(root, ["rev-list", "--parents", "-n", "1", commit]);
  return r.code === 0 ? r.stdout.trim().split(" ").slice(1) : null;
}

/**
 * A `fixup!` or `squash!` commit that conflicted is folded into the commit
 * before it: the rebase continues by amending `head`, so the concluding
 * commit stands beside `head` (same parent) instead of above it.
 */
function amendedCommit(
  root: string,
  head: string,
  incoming: string,
): string | null {
  const subject = gitRaw(root, ["log", "-1", "--format=%s", incoming]);
  if (subject.code !== 0 || !/^(fixup|squash|amend)! /.test(subject.stdout))
    return null;
  const current = gitRaw(root, ["rev-parse", "HEAD"]).stdout.trim();
  if (current === "" || current === head) return null;
  const sibling = parentsOf(root, current)?.[0];
  return sibling !== undefined && sibling === parentsOf(root, head)?.[0]
    ? current
    : null;
}

/** Whether `commit` is what an operation of `kind` on `incoming` makes. */
function belongsTo(
  root: string,
  kind: OperationKind,
  incoming: string,
  commit: string,
  parents: readonly string[],
): boolean {
  if (kind === "merge") return parents[1] === incoming;
  if (kind === "revert") {
    const body = gitRaw(root, ["log", "-1", "--format=%B", commit]);
    return (
      body.code === 0 && body.stdout.includes(`This reverts commit ${incoming}`)
    );
  }
  // The merge a `--rebase-merges` rebase recreates has the rebased side as its second parent.
  if (kind === "rebase" && parents[1] === incoming) return true;
  // A cherry-pick and a rebase keep the author and the author date.
  const format = "--format=%an%x00%ae%x00%at";
  const a = gitRaw(root, ["log", "-1", format, commit]);
  const b = gitRaw(root, ["log", "-1", format, incoming]);
  return a.code === 0 && b.code === 0 && a.stdout === b.stdout;
}

function branchOf(snapshot: Snapshot): string | null {
  const { kind } = snapshot.operation;
  return kind === "rebase"
    ? snapshot.sides.theirs.ref
    : snapshot.sides.ours.ref;
}

/** The pull request a drive is working, from the environment its passes run in. */
function drivenPullRequest(env: NodeJS.ProcessEnv): number | null {
  const value = env.DRIVE_PR_TARGET ?? "";
  return /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : null;
}

/** One event for each path of the snapshot, for the operation that concluded with `commit`. */
export function buildEvents(
  root: string,
  snapshot: Snapshot,
  commit: string,
  env: NodeJS.ProcessEnv = process.env,
): MergeConflictEvent[] {
  const causes = snapshotCauses(root, snapshot.paths);
  const concluded =
    Number(git(root, ["log", "-1", "--format=%ct", commit]).trim()) * 1000;
  const mapped = Date.parse(snapshot.mappedAt);
  const driven = env.DRIVE_PR_ROUND_TASK === "conflict-resolve";
  const { ours, theirs } = snapshot.sides;
  const common = {
    type: EVENT_TYPE,
    ts: new Date(concluded).toISOString(),
    operation: snapshot.operation.kind,
    resolution_ms: Number.isFinite(mapped)
      ? Math.max(0, concluded - mapped)
      : null,
    source: driven ? "drive-pr" : "session",
    commit,
    pr: driven ? drivenPullRequest(env) : null,
    branch: branchOf(snapshot),
    ours_commit: ours.commit,
    ours_ref: ours.ref,
    theirs_commit: theirs.commit,
    theirs_ref: theirs.ref,
  } as const;
  return Object.entries(snapshot.paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, entry]) => {
      const found: PathCauses | undefined = causes.get(path);
      if (found === undefined) return [];
      return [
        {
          ...common,
          path,
          cause: found.cause,
          causes: found.causes,
          regions: found.regions,
          decision: entry.resolution.decision,
          reason: entry.resolution.reason,
        },
      ];
    });
}

/** The live record cannot be written where it belongs. */
export class LiveRecordError extends Error {
  override name = "LiveRecordError";
}

/** Whether something is at `path` and is a symbolic link, even a dangling one. */
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw err;
  }
}

export function eventsPath(root: string): string {
  return join(commonDir(root), "jig", EVENTS_FILE);
}

/**
 * What identifies one conflict: the commit the operation concluded with and
 * the path, and the operation itself (its kind and two sides) and the path,
 * so a concluding commit rewritten in place, or a rebase stop run again
 * after an abort, is the same conflict and counts once.
 */
function keysOf(event: Partial<Record<string, unknown>>): string[] {
  const { path, commit, operation, ours_commit, theirs_commit } = event;
  const text = (v: unknown): v is string => typeof v === "string";
  if (!text(path)) return [];
  return [
    ...(text(commit) ? [`commit\0${commit}\0${path}`] : []),
    ...(text(operation) && text(ours_commit) && text(theirs_commit)
      ? [`operation\0${operation}\0${ours_commit}\0${theirs_commit}\0${path}`]
      : []),
  ];
}

/** The commit and path of each event already in the file; a line that is not an event is skipped. */
function recorded(file: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) for (const key of keysOf(parsed)) keys.add(key);
    } catch (err) {
      swallow(err, "a line that is not JSON is no recorded event");
    }
  }
  return keys;
}

/**
 * Append the events the file does not hold yet, in one write so that
 * worktrees recording together do not interleave lines. A symbolic link at
 * the file or its directory is refused: the record is never written through
 * one.
 */
export function appendEvents(
  root: string,
  events: readonly MergeConflictEvent[],
): { written: number; skipped: number; file: string } {
  const file = eventsPath(root);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  for (const path of [dir, file]) {
    if (isSymbolicLink(path))
      throw new LiveRecordError(
        `${path} is a symbolic link; the live record is not written through one`,
      );
  }
  const seen = recorded(file);
  const fresh = events.filter(
    (event) => !keysOf({ ...event }).some((key) => seen.has(key)),
  );
  if (fresh.length > 0)
    appendFileSync(
      file,
      `${fresh.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  return { written: fresh.length, skipped: events.length - fresh.length, file };
}

export interface Recorded {
  /** The commit the operation concluded with; null when it has not concluded. */
  commit: string | null;
  written: number;
  skipped: number;
  file: string | null;
}

/** Record the events of the operation `snapshot` describes, if it has concluded. */
export function recordConcluded(
  root: string,
  snapshot: Snapshot,
  env: NodeJS.ProcessEnv = process.env,
): Recorded {
  const commit = concludedCommit(root, snapshot);
  if (commit === null) return { commit, written: 0, skipped: 0, file: null };
  const done = appendEvents(root, buildEvents(root, snapshot, commit, env));
  return { commit, ...done };
}
