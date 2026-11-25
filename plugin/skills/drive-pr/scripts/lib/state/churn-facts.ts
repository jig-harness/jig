/**
 * The facts a recorded round carries beside its anchor paths, for the
 * structural-churn brake (`churn.ts`): whether the round's live findings
 * included a `high` or `blocker` one, and the git blob id of each anchored
 * file at the head the round was evaluated on. Both are optional, so a round
 * recorded without them (or before they existed) still loads; the validator
 * refuses a malformed one, since the brake's answer is only as good as them.
 */

import { isRecord } from "../../../../../shared/guards.ts";

/** What `record-paths` may store beside a round's paths. */
export interface RoundFacts {
  severe?: boolean;
  blobs?: Record<string, string>;
}

/** A git object id: SHA-1 or SHA-256, lowercase hex. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `v` is a git object id as `git cat-file` prints one. */
export function isObjectId(v: unknown): v is string {
  return typeof v === "string" && OBJECT_ID.test(v);
}

/**
 * Whether a stored entry's facts are absent or well-formed: `severe` a
 * boolean, `blobs` an object naming only paths the entry records, each with
 * an object id.
 */
export function isRoundFacts(
  severe: unknown,
  blobs: unknown,
  paths: readonly string[],
): boolean {
  if (severe !== undefined && typeof severe !== "boolean") return false;
  if (blobs === undefined) return true;
  if (!isRecord(blobs)) return false;
  const recorded = new Set(paths);
  return Object.entries(blobs).every(
    ([path, id]) => recorded.has(path) && isObjectId(id),
  );
}

/**
 * The facts as stored for an entry recording `paths`: blob ids only for
 * those paths and only well-formed ones, and no `blobs` at all when none is
 * left, so the writer can never store what the validator refuses.
 */
export function roundFactsFor(
  paths: readonly string[],
  facts: RoundFacts,
): RoundFacts {
  const recorded = new Set(paths);
  const blobs = Object.fromEntries(
    Object.entries(facts.blobs ?? {}).filter(
      ([path, id]) => recorded.has(path) && isObjectId(id),
    ),
  );
  return {
    ...(facts.severe === undefined ? {} : { severe: facts.severe }),
    ...(Object.keys(blobs).length === 0 ? {} : { blobs }),
  };
}

/**
 * Why a parsed `--stdin-json` object is not a round's input, or `null`. A
 * malformed blob is refused, not dropped: the caller sent something it did
 * not mean, and storing the rest would hide that.
 */
function inputProblem(value: Record<string, unknown>): string | null {
  const { paths, severe, blobs, round } = value;
  if (
    round !== undefined &&
    !(typeof round === "number" && Number.isInteger(round) && round >= 1)
  )
    return "round must be a positive integer";
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string"))
    return "paths must be a list of strings";
  if (severe !== undefined && typeof severe !== "boolean")
    return "severe must be true or false";
  return blobs === undefined ? null : blobsProblem(blobs, paths as string[]);
}

/** Why `blobs` is not a map from recorded paths to object ids, or `null`. */
function blobsProblem(blobs: unknown, paths: readonly string[]): string | null {
  if (!isRecord(blobs)) return "blobs must map each path to an object id";
  const recorded = new Set(paths);
  for (const [path, id] of Object.entries(blobs)) {
    if (!recorded.has(path))
      return `blobs names ${JSON.stringify(path)}, which paths does not list`;
    if (!isObjectId(id))
      return `blobs gives ${JSON.stringify(path)} ${JSON.stringify(id)}, which is not a git object id`;
  }
  return null;
}

/**
 * Read the JSON form of `record-paths --stdin-json`: `{"paths": [...],
 * "severe"?: bool, "blobs"?: {path: id}, "round"?: n}`, or the problem that makes the
 * text not one, so the command refuses it rather than storing a guess.
 */
export function parseRoundInput(
  text: string,
):
  | { paths: string[]; facts: RoundFacts; round?: number }
  | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      problem: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(value)) return { problem: "not a JSON object" };
  const problem = inputProblem(value);
  if (problem !== null) return { problem };
  const { severe, blobs } = value as RoundFacts;
  return {
    paths: value.paths as string[],
    ...(value.round === undefined ? {} : { round: value.round as number }),
    facts: {
      ...(severe === undefined ? {} : { severe }),
      ...(blobs === undefined ? {} : { blobs }),
    },
  };
}
