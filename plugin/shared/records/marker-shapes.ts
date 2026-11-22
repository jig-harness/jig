/** Structural payloads of stable JSON markers, including earlier claim markers without an attempt. */
import { s } from "../shapes.ts";

export const CLAIM_OUTCOMES = ["claimed", "released", "unresolved"] as const;
export const CLAIM_MARKER_PAYLOAD_SHAPE = s.object({
  // Earlier readers ignore a malformed attempt, so its presence does not govern acceptance.
  attempt: s.optional(s.unknown()),
  session: s.string(),
  branch: s.string(),
  claimant: s.string(),
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
