/**
 * What a repository's `do_item` section adds to every claim:
 *
 * - `claim_from`: the canonical states work may start from. Unset, a claim
 *   keeps its own rule (any state but `in_progress`), and is not limited to
 *   `dispatch.states`. Set, an item in any other state, or in a status that
 *   maps to no canonical state, is refused with nothing written.
 * - `claim_marker`: a successful claim posts the claim marker
 *   (`claim-marker.ts`). Off by default.
 *
 * A value the claim cannot use is an error naming the field, so a
 * misconfigured repository fails the claim rather than claiming unchecked.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { JigError } from "../../../../shared/outcome.ts";
import { doItemSection } from "./overlay.ts";
import { CANONICAL_STATES, type CanonicalState } from "./tracker/port.ts";

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
  // The claim moves an item there: an item already in it is someone's.
  if (value.includes("in_progress"))
    throw new ClaimSettingsError(
      "do_item.claim_from cannot list in_progress, the state a claim moves an item to",
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
