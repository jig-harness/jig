/** Structural payloads of stable JSON markers, including earlier claim markers without an attempt. */
import { s } from "../shapes.ts";

export const CLAIM_OUTCOMES = ["claimed", "released", "unresolved"] as const;
/**
 * A claim a person started ahead of the item's open blockers: their reason,
 * the identity the claim acted as, and each open blocker's key and state as
 * the claim read them (`null` for one it could not read); `preflight` is the
 * repository's preflight refusal for blockers it cleared.
 */
export const CLAIM_OVERRIDE_SHAPE = s.object({
  reason: s.string(),
  person: s.string(),
  blockers: s.array(
    s.object({ key: s.string(), state: s.nullable(s.string()) }),
  ),
  preflight: s.optional(s.string()),
});
export const CLAIM_MARKER_PAYLOAD_SHAPE = s.object({
  // Earlier readers ignore a malformed attempt, so its presence does not govern acceptance.
  attempt: s.optional(s.unknown()),
  session: s.string(),
  branch: s.string(),
  claimant: s.string(),
  // A record for people, shaped as CLAIM_OVERRIDE_SHAPE: like a malformed attempt, it never governs acceptance.
  override: s.optional(s.unknown()),
});
export const CLAIM_OUTCOME_PAYLOAD_SHAPE = s.object({
  attempt: s.string(),
  outcome: s.enum(CLAIM_OUTCOMES),
});

/** The attachment header fields its reader uses; other metadata is checked when the file is read. */
export const ATTACHMENT_MARKER_SHAPE = s.object({
  form: s.enum(["comment", "link"]),
  title: s.string(),
  filename: s.string(),
  subtitle: s.optional(s.unknown()),
  contentType: s.optional(s.unknown()),
  size: s.optional(s.unknown()),
  sha256: s.optional(s.unknown()),
  url: s.optional(s.unknown()),
});

/** The sent-answer reader checks only the envelope; its payload adds no authority. */
export const ANSWER_PAYLOAD_SHAPE = s.object({
  pr: s.optional(s.unknown()),
  decision: s.optional(s.unknown()),
  choice: s.optional(s.unknown()),
});

/** The rearm request binds a label to the stop comment it asked to restart; a withdrawal carries no stop. */
export const REARM_REQUEST_PAYLOAD_SHAPE = s.object({
  label: s.string(),
  stopComment: s.nullable(s.integer()),
  requestId: s.optional(s.unknown()),
  reason: s.optional(s.unknown()),
  needsPerson: s.optional(s.unknown()),
  failureStop: s.optional(s.unknown()),
  failureGeneration: s.optional(s.unknown()),
});
