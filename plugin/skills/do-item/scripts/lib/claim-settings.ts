/**
 * What a repository's `do_item` section adds to every claim:
 *
 * - `claim_from`: the canonical states work may start from. Unset, a claim
 *   keeps its own restrictions (never `in_progress` or `pr_open`), and is not limited to
 *   `dispatch.states`. Set, an item in any other state, or in a status that
 *   maps to no canonical state, is refused with nothing written.
 * - `claim_marker`: a successful claim posts the claim marker
 *   (`claim-marker.ts`). Off by default.
 *
 * A value the claim cannot use is an error naming the field, so a
 * misconfigured repository fails the claim rather than claiming unchecked.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { JigError, type Outcome } from "../../../../shared/outcome.ts";
import { defaultBranchSettings } from "../../../../shared/repo-command.ts";
import { doItemSection } from "./overlay.ts";
import { CANONICAL_STATES, type CanonicalState } from "./tracker/port.ts";
import { executionPlanBlock } from "../select_execution_issue.ts";

/** The `do_item` section holds a claim setting the claim cannot use. */
export class ClaimSettingsError extends JigError<"invalid-claim-setting"> {
  constructor(reason: string) {
    super("invalid-claim-setting", reason);
  }
}

export interface ClaimSettings {
  claimFrom: CanonicalState[] | null;
  claimMarker: boolean;
}

function claimFrom(value: unknown): CanonicalState[] | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((s) => !(CANONICAL_STATES as readonly unknown[]).includes(s))
  )
    throw new ClaimSettingsError(
      `do_item.claim_from must be a nonempty list of canonical states (${CANONICAL_STATES.join(", ")})`,
    );
  if (new Set(value).size !== value.length)
    throw new ClaimSettingsError("do_item.claim_from lists a state twice");
  // The claim moves an item to in_progress, and an item in pr_open already has
  // a pull request: either is someone's.
  for (const s of ["in_progress", "pr_open"])
    if (value.includes(s))
      throw new ClaimSettingsError(
        `do_item.claim_from cannot list ${s}: an item there is already someone's`,
      );
  return value as CanonicalState[];
}

/** The claim settings `overlay` sets; every one unset keeps today's claim. */
export function claimSettingsOf(
  overlay: Record<string, unknown> | null,
): ClaimSettings {
  const section = doItemSection(overlay);
  if (section === undefined || section === null)
    return { claimFrom: null, claimMarker: false };
  if (!isRecord(section))
    throw new ClaimSettingsError("do_item must be a mapping");
  const marker = section.claim_marker;
  if (marker !== undefined && marker !== null && typeof marker !== "boolean")
    throw new ClaimSettingsError("do_item.claim_marker must be true or false");
  return {
    claimFrom: claimFrom(section.claim_from),
    claimMarker: marker === true,
  };
}

/**
 * The claim settings a claim applies: the default branch's, like
 * `do_item.preflight_command`, so a branch cannot widen its own allowed
 * states or switch off the marker. When the default branch cannot be read,
 * a working tree that sets either refuses the claim; one that sets neither
 * claims with the defaults.
 */
export async function claimSettingsFromDefaultBranch(
  root: string,
  workingTree: Record<string, unknown> | null,
): Promise<Outcome<ClaimSettings, "unreadable">> {
  // One read answers both fields, so a restriction read is never dropped
  // because a second read failed.
  const read = await defaultBranchSettings(root, "do_item", [
    "claim_from",
    "claim_marker",
  ]);
  if (read.ok)
    return {
      ok: true,
      value: claimSettingsOf({
        do_item: {
          claim_from: read.value.claim_from,
          claim_marker: read.value.claim_marker,
        },
      }),
    };
  const own = claimSettingsOf(workingTree);
  if (own.claimFrom === null && !own.claimMarker)
    return { ok: true, value: own };
  return {
    ok: false,
    failure: {
      code: "unreadable",
      reason: `do_item.claim_from and do_item.claim_marker are read from the default branch, which could not be read: ${read.failure.reason}`,
    },
  };
}

function namedBlock(overlay: Record<string, unknown> | null): string {
  try {
    return executionPlanBlock(overlay);
  } catch (err) {
    throw new ClaimSettingsError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The execution-plan block name a claim authorizes against: the default
 * branch's, so a branch cannot select a different fenced block than the one
 * that holds the human gates. When the default branch cannot be read, the
 * claim is refused whatever the working tree sets: the trusted selector is
 * unknown, and the working tree's choice cannot stand in for it.
 */
export async function claimPlanBlockFromDefaultBranch(
  root: string,
): Promise<Outcome<string, "unreadable">> {
  const read = await defaultBranchSettings(root, "do_item", [
    "execution_plan_block",
  ]);
  if (read.ok)
    return {
      ok: true,
      value: namedBlock({
        do_item: { execution_plan_block: read.value.execution_plan_block },
      }),
    };
  return {
    ok: false,
    failure: {
      code: "unreadable",
      reason: `do_item.execution_plan_block is read from the default branch, which could not be read: ${read.failure.reason}`,
    },
  };
}
