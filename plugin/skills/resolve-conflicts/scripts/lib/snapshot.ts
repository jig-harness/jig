/**
 * The conflict snapshot: the map `conflict-map.ts` writes and the resolution
 * record the resolver fills in, kept in one JSON file inside the git
 * directory (`<git-dir>/jig/conflicts.json`), so it is never committed.
 *
 * It holds the stage blob ids of every conflicted path. Once a path is staged
 * with `git add`, git forgets which versions conflicted, but the blobs remain
 * in the object store, so the check after resolution can still compare the
 * resolved file with both sides.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "../../../../shared/cli.ts";
import type { PathClass, Regenerate } from "./classify.ts";
import { gitPath } from "./git.ts";
import type { Hunk } from "./markers.ts";
import {
  detectOperation,
  NoOperation,
  type Operation,
  type OperationKind,
  type Side,
  type SideName,
} from "./operation.ts";
import { isRecord } from "../../../../shared/guards.ts";

export const DECISIONS = [
  "combined",
  "ours",
  "theirs",
  "rewritten",
  "regenerated",
  "deleted",
  "escalate",
] as const;
export type Decision = (typeof DECISIONS)[number];

/** Decisions that drop or replace a change, or ask a human: a reason is required. */
export const NEEDS_REASON: ReadonlySet<Decision> = new Set([
  "ours",
  "theirs",
  "rewritten",
  "deleted",
  "escalate",
]);

export function isDecision(value: unknown): value is Decision {
  return (DECISIONS as readonly unknown[]).includes(value);
}

export type Kind =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "deleted-by-ours"
  | "deleted-by-theirs"
  | "added-by-ours"
  | "added-by-theirs";

export interface Stage {
  mode: string;
  blob: string;
}

export interface IntentCommit {
  sha: string;
  subject: string;
  /** The pull request the subject names (`(#123)`, `Merge pull request #123`). */
  pr: number | null;
}

export interface Intent {
  commits: IntentCommit[];
  truncated: boolean;
  /** Where this side moved the path, when it deleted it by renaming it. */
  renamedTo: string | null;
}

export interface Acknowledgement {
  why: string;
  lines: { side: SideName; text: string }[];
}

export interface Resolution {
  decision: Decision | null;
  reason: string | null;
  /** The command that rebuilt the path, for `regenerated`. */
  command: string | null;
  /** Lines of a side intentionally gone under `combined`, and why. */
  dropped: Acknowledgement | null;
}

export interface PathEntry {
  kind: Kind;
  class: PathClass;
  markerSize: number;
  regenerate: Regenerate | null;
  stages: { base: Stage | null; ours: Stage | null; theirs: Stage | null };
  hunks: Hunk[];
  intent: { ours: Intent; theirs: Intent };
  resolution: Resolution;
  /**
   * `true` for a path the operation merged cleanly, mapped only because a
   * manual adjustment to it needed a decision. Absent for a path that
   * conflicted.
   */
  clean?: true;
}

/** What started the resolution: a drive's conflict-resolve round, or a session. */
export interface Attribution {
  source: "drive-pr" | "session";
  /** The pull request being driven, when `source` is `drive-pr`. */
  pr: number | null;
}

export interface Snapshot {
  version: 1;
  operation: {
    kind: OperationKind;
    head: string;
    incoming: string;
    base: string | null;
  };
  sides: {
    ours: Side;
    theirs: Side;
    integration: SideName;
    integrationWhy: string;
  };
  warning: string | null;
  /**
   * Why the change-area catalog's generated declarations could not all be
   * honoured when the map was written (the catalog could not be read, or an
   * entry's `outputs` are malformed), or `null`. While set, the classes are
   * incomplete and the check refuses; a map that honours every declaration
   * clears it. Absent in a snapshot an earlier version wrote, which is read
   * as `null`.
   */
  catalogIncomplete?: string | null;
  mappedAt: string;
  /**
   * What started the resolution, taken when the operation was first mapped.
   * Absent in a snapshot an earlier version wrote.
   */
  attribution?: Attribution;
  paths: Record<string, PathEntry>;
}

/** The conflict kind git's unmerged stages describe. */
export function kindOf(stages: PathEntry["stages"]): Kind {
  const { base, ours, theirs } = stages;
  if (ours && theirs) return base ? "both-modified" : "both-added";
  if (base && theirs) return "deleted-by-ours";
  if (base && ours) return "deleted-by-theirs";
  if (ours) return "added-by-ours";
  if (theirs) return "added-by-theirs";
  return "both-deleted";
}

export function emptyResolution(): Resolution {
  return { decision: null, reason: null, command: null, dropped: null };
}

/**
 * The snapshot's own directory entry. Git makes an absolute path real,
 * following a symlink in the last component too, so only the directory is
 * resolved through git: a symlink at the snapshot path is then seen, not
 * followed.
 */
export function snapshotPath(root: string): string {
  return join(gitPath(root, "jig"), "conflicts.json");
}

/**
 * The stored snapshot, or null when there is none. Null means exactly that no
 * directory entry exists at the snapshot path. Anything else that is not a
 * readable snapshot this skill wrote throws: a symlink (even one whose target
 * is gone), a file that cannot be read or parsed, or JSON of the wrong shape.
 * Treating any of those as absent would let the next map replace the only
 * record of the paths staged since it was written, and a wrongly shaped
 * record could let the check pass over paths it never looks at.
 */
export function loadSnapshot(root: string): Snapshot | null {
  const path = snapshotPath(root);
  try {
    if (!lstatSync(path).isFile())
      throw new Error(`${path} is not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const problem = snapshotProblem(parsed);
  if (problem !== null)
    throw new Error(
      `${path} is not a conflict snapshot this skill wrote: ${problem}`,
    );
  return parsed as Snapshot;
}

const OPERATION_KINDS: readonly unknown[] = [
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
];
const SIDE_NAMES: readonly unknown[] = ["ours", "theirs"];
const KINDS: readonly unknown[] = [
  "both-modified",
  "both-added",
  "both-deleted",
  "deleted-by-ours",
  "deleted-by-theirs",
  "added-by-ours",
  "added-by-theirs",
];
const CLASSES: readonly unknown[] = ["lockfile", "generated", "binary", "text"];

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * A pull request number as the snapshot stores it. `conflict-map.ts` reads
 * numbers from commit subjects with this same predicate, so a subject the
 * loader would refuse (`(#0)`, a number past the safe-integer range) is
 * stored as no pull request rather than as an unloadable snapshot.
 */
export function isPullRequestNumber(value: unknown): value is number {
  return isPositiveInteger(value) && Number.isSafeInteger(value);
}

function sideProblem(value: unknown): string | null {
  if (!isRecord(value)) return "is not an object";
  if (typeof value.commit !== "string") return "has no commit";
  if (!isStringOrNull(value.ref)) return "has a ref that is not a string";
  if (typeof value.subject !== "string" || typeof value.role !== "string")
    return "has no subject or role";
  return null;
}

function stageProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!isRecord(value)) return "is not an object";
  if (typeof value.mode !== "string" || typeof value.blob !== "string")
    return "has no mode or blob";
  return null;
}

function regenerateProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!isRecord(value)) return "is not an object";
  if (typeof value.command !== "string" || typeof value.cwd !== "string")
    return "has no command or directory";
  if (
    !["built-in", "configuration", "catalog"].includes(value.source as string)
  )
    return "has an unknown source";
  return null;
}

function hunkProblem(value: unknown): string | null {
  if (!isRecord(value)) return "is not an object";
  if (!isPositiveInteger(value.start) || !isPositiveInteger(value.end))
    return "has no line range";
  if ((value.end as number) < (value.start as number))
    return "ends before it starts";
  for (const name of ["oursLabel", "theirsLabel", "ours", "theirs"])
    if (typeof value[name] !== "string") return `has no ${name}`;
  if (!isStringOrNull(value.baseLabel) || !isStringOrNull(value.base))
    return "has a base that is not a string";
  return null;
}

function intentProblem(value: unknown): string | null {
  if (!isRecord(value)) return "is not an object";
  if (!Array.isArray(value.commits)) return "has no commit list";
  for (const commit of value.commits) {
    if (
      !isRecord(commit) ||
      typeof commit.sha !== "string" ||
      typeof commit.subject !== "string" ||
      !(commit.pr === null || isPullRequestNumber(commit.pr))
    )
      return "has a commit without a sha, subject or pull request number";
  }
  if (typeof value.truncated !== "boolean") return "has no truncated flag";
  if (!isStringOrNull(value.renamedTo))
    return "has a renamedTo that is not a string";
  return null;
}

/** The stages of a path entry, each well formed and together those of `kind`. */
function stagesProblem(stages: unknown, kind: unknown): string | null {
  if (!isRecord(stages)) return "has no stages";
  for (const name of ["base", "ours", "theirs"]) {
    const problem = stageProblem(stages[name]);
    if (problem !== null) return `has a ${name} stage that ${problem}`;
  }
  if (stages.base === null && stages.ours === null && stages.theirs === null)
    return "has no stage at all";
  const implied = kindOf(stages as PathEntry["stages"]);
  if (implied !== kind)
    return `is recorded as ${kind}, but its stages are those of ${implied}`;
  return null;
}

/** The hunks and the intent of both sides a path entry carries. */
function evidenceProblem(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.hunks)) return "has no hunk list";
  for (const hunk of value.hunks) {
    const problem = hunkProblem(hunk);
    if (problem !== null) return `has a hunk that ${problem}`;
  }
  if (!isRecord(value.intent)) return "has no intent";
  for (const name of ["ours", "theirs"]) {
    const problem = intentProblem(value.intent[name]);
    if (problem !== null) return `has an intent for ${name} that ${problem}`;
  }
  return null;
}

/**
 * Every field of a path entry, held to the values `conflict-map.ts` writes,
 * and the kind to the stages: the check compares the resolved file with the
 * stages the kind promises, and finds markers at the recorded size. The
 * resolution's own fields are hand-editable and judged by check-resolution.ts,
 * so only its presence as an object is checked here.
 */
function entryProblem(value: unknown): string | null {
  if (!isRecord(value)) return "is not an object";
  if (!KINDS.includes(value.kind)) return "has an unknown kind";
  if (!CLASSES.includes(value.class)) return "has an unknown class";
  if (!isPositiveInteger(value.markerSize))
    return "has a marker size that is not a positive integer";
  const regenerate = regenerateProblem(value.regenerate);
  if (regenerate !== null) return `has a regenerate that ${regenerate}`;
  const stages = stagesProblem(value.stages, value.kind);
  if (stages !== null) return stages;
  const evidence = evidenceProblem(value);
  if (evidence !== null) return evidence;
  if (!isRecord(value.resolution)) return "has no resolution";
  if (value.clean !== undefined && value.clean !== true)
    return "has a clean flag that is not true";
  return null;
}

function attributionProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "is not an object";
  if (value.source !== "drive-pr" && value.source !== "session")
    return "has an unknown source";
  if (value.pr !== null && !isPositiveInteger(value.pr))
    return "has a pull request that is not a positive integer";
  return null;
}

/** Why `value` is not a snapshot, or null when it has the full shape. */
export function snapshotProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (value.version !== 1) return "version is not 1";
  const op = value.operation;
  if (!isRecord(op)) return "no operation";
  if (!OPERATION_KINDS.includes(op.kind)) return "unknown operation kind";
  if (typeof op.head !== "string" || typeof op.incoming !== "string")
    return "operation has no head or incoming commit";
  if (!isStringOrNull(op.base)) return "operation base is not a string";
  const sides = value.sides;
  if (!isRecord(sides)) return "no sides";
  for (const name of ["ours", "theirs"]) {
    const problem = sideProblem(sides[name]);
    if (problem !== null) return `side ${name} ${problem}`;
  }
  if (!SIDE_NAMES.includes(sides.integration))
    return "integration side is neither ours nor theirs";
  if (typeof sides.integrationWhy !== "string")
    return "no reason for the integration side";
  return mapProblem(value);
}

/** Why the snapshot's map-level fields and paths are malformed, or null. */
function mapProblem(value: Record<string, unknown>): string | null {
  if (!isStringOrNull(value.warning)) return "warning is not a string";
  if (!isStringOrNull(value.catalogIncomplete ?? null))
    return "catalogIncomplete is not a string";
  if (typeof value.mappedAt !== "string") return "no mapping time";
  const attribution = attributionProblem(value.attribution);
  if (attribution !== null) return `attribution ${attribution}`;
  if (!isRecord(value.paths)) return "the path map is not an object";
  for (const [path, entry] of Object.entries(value.paths)) {
    const problem = entryProblem(entry);
    if (problem !== null) return `path ${JSON.stringify(path)} ${problem}`;
  }
  return null;
}

/**
 * Writes the snapshot, refusing one `loadSnapshot` would reject: a snapshot
 * every later step refuses to read is worse than none, so a disagreement
 * between what is built and what is accepted fails here, where it was made.
 */
export function saveSnapshot(root: string, snapshot: Snapshot): string {
  const path = snapshotPath(root);
  const problem = snapshotProblem(snapshot);
  if (problem !== null)
    throw new Error(`refusing to write a conflict snapshot: ${problem}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(temporary, path);
  return path;
}

export function sameOperation(
  snapshot: Snapshot,
  operation: Pick<Operation, "kind" | "head" | "incoming">,
): boolean {
  return (
    snapshot.operation.kind === operation.kind &&
    snapshot.operation.head === operation.head &&
    snapshot.operation.incoming === operation.incoming
  );
}

export function describeOperation(op: {
  kind: string;
  head: string;
  incoming: string;
}): string {
  return `${op.kind} of ${op.incoming.slice(0, 12)} onto ${op.head.slice(0, 12)}`;
}

/**
 * The current operation and its snapshot, for the scripts that run after
 * mapping. Exit 3 when no operation is in progress, when there is no
 * snapshot, or when the snapshot belongs to a different operation.
 */
export function currentSnapshot(
  name: string,
  root: string,
): { operation: Operation; snapshot: Snapshot } {
  let operation: Operation;
  try {
    operation = detectOperation(root);
  } catch (err) {
    if (err instanceof NoOperation) fail(3, `${name}: ${err.message}`);
    throw err;
  }
  let snapshot: Snapshot | null;
  try {
    snapshot = loadSnapshot(root);
  } catch (err) {
    fail(
      3,
      `${name}: ${err instanceof Error ? err.message : err}`,
      "Run conflict-map.ts to map the conflicts again.",
    );
  }
  if (snapshot === null)
    fail(
      3,
      `${name}: no conflict snapshot for this ${operation.kind}.`,
      "Run conflict-map.ts first, before resolving anything.",
    );
  if (!sameOperation(snapshot, operation))
    fail(
      3,
      `${name}: the conflict snapshot belongs to a different operation (${describeOperation(snapshot.operation)}); the one in progress is the ${describeOperation(operation)}.`,
      "Run conflict-map.ts to map this one.",
    );
  return { operation, snapshot };
}
