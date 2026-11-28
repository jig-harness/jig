/**
 * What a repository's `do_item` section adds to every claim:
 *
 * - `claim_from`: the canonical states work may start from. Unset, a claim
 *   keeps its own restrictions (never `in_progress` or `pr_open`), and is not limited to
 *   `dispatch.states`. Set, an item in any other state, or in a status that
 *   maps to no canonical state, is refused with nothing written.
 * - `claim_marker`: a successful claim posts the claim marker
 *   (`claim-marker.ts`). Off by default.
 * - `override_label`: the label a claim a person started ahead of open
 *   blockers adds to the item (`blocker-override.ts`). Unset by default.
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
  /** `do_item.override_label`; `null` when unset. */
  overrideLabel: string | null;
}

function overrideLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "")
    throw new ClaimSettingsError(
      "do_item.override_label must be a label's name (nonempty text)",
    );
  return value;
}

/**
 * States a claim never starts from. The claim moves an item to in_progress,
 * and an item in pr_open already has a pull request: either is someone's. An
 * item in blocked waits on a person's answer.
 */
const CLAIM_FROM_BARRED: readonly (readonly [string, string])[] = [
  ["in_progress", "an item there is already someone's"],
  ["pr_open", "an item there is already someone's"],
  ["blocked", "an item there waits on a person's answer"],
];

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
  const barred = CLAIM_FROM_BARRED.find(([state]) => value.includes(state));
  if (barred)
    throw new ClaimSettingsError(
      `do_item.claim_from cannot list ${barred[0]}: ${barred[1]}`,
    );
  return value as CanonicalState[];
}

/** The claim settings `overlay` sets; every one unset keeps today's claim. */
export function claimSettingsOf(
  overlay: Record<string, unknown> | null,
): ClaimSettings {
  const section = doItemSection(overlay);
  if (section === undefined || section === null)
    return { claimFrom: null, claimMarker: false, overrideLabel: null };
  if (!isRecord(section))
    throw new ClaimSettingsError("do_item must be a mapping");
  const marker = section.claim_marker;
  if (marker !== undefined && marker !== null && typeof marker !== "boolean")
    throw new ClaimSettingsError("do_item.claim_marker must be true or false");
  return {
    claimFrom: claimFrom(section.claim_from),
    claimMarker: marker === true,
    overrideLabel: overrideLabel(section.override_label),
  };
}

/**
 * The claim settings a claim applies: the default branch's, like
 * `do_item.preflight_command`, so a branch cannot widen its own allowed
 * states, switch off the marker or drop the override label. When the
 * default branch cannot be read, a working tree that sets any of them
 * refuses the claim; one that sets none claims with the defaults.
 */
export async function claimSettingsFromDefaultBranch(
  root: string,
  workingTree: Record<string, unknown> | null,
): Promise<Outcome<ClaimSettings, "unreadable">> {
  // One read answers every field, so a restriction read is never dropped
  // because a second read failed.
  const read = await defaultBranchSettings(root, "do_item", [
    "claim_from",
    "claim_marker",
    "override_label",
  ]);
  if (read.ok)
    return {
      ok: true,
      value: claimSettingsOf({
        do_item: {
          claim_from: read.value.claim_from,
          claim_marker: read.value.claim_marker,
          override_label: read.value.override_label,
        },
      }),
    };
  const own = claimSettingsOf(workingTree);
  if (own.claimFrom === null && !own.claimMarker && own.overrideLabel === null)
    return { ok: true, value: own };
  return {
    ok: false,
    failure: {
      code: "unreadable",
      reason: `do_item.claim_from, do_item.claim_marker and do_item.override_label are read from the default branch, which could not be read: ${read.failure.reason}`,
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

/** Factory inheritance trusts only the repository's default-branch identity. */
export async function claimFactoryIdentityFromDefaultBranch(
  root: string,
): Promise<Outcome<string, "unreadable">> {
  const read = await defaultBranchSettings(root, "dispatch", ["identity"]);
  if (!read.ok) return read;
  const identity = read.value.identity;
  return typeof identity === "string" && identity.trim() !== ""
    ? { ok: true, value: identity.trim() }
    : {
        ok: false,
        failure: {
          code: "unreadable",
          reason:
            "factory inheritance requires dispatch.identity on the default branch",
        },
      };
}
