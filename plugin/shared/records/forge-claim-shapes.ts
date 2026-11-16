/**
 * The shapes of three forge claims' records beside their envelope: the
 * takeover claim, the launch claim and the merge-ready announcement. Each
 * claim's reader (`skills/drive-pr/scripts/lib/state/ledger.ts`,
 * `launch-claims.ts`, `skills/drive-pr/scripts/lib/announce.ts`) accepts a
 * record only when it fits its shape here, and the Jig Protocol's chapter on
 * forge claims publishes each claim's schema from the same description. What
 * a shape cannot say stays with its reader: that a takeover claim's key
 * repeats its generation, that a launch claim names the pull request it is
 * on, and that an announcement's record and its head marker name one head.
 *
 * Fields a reader has always read loosely stay loose here (an unknown value
 * of a launch's `conflictStop`, or of its end's `by` and `cause`, reads as
 * absent), so that every claim a reader accepted before still reads.
 */
import { s, type Shape } from "../shapes.ts";
import { LAUNCH_CLAIM_VALUES } from "./forge-claim-values.ts";
import { FOLLOWUP_OUTCOMES, type TickOutcome } from "./followup-values.ts";

/** An action a launch claim names. */
type LaunchAction = keyof (typeof LAUNCH_CLAIM_VALUES)["action"];
/** A state a launch's end is in. */
export type LaunchEndState = keyof (typeof LAUNCH_CLAIM_VALUES)["end.state"];

/** A dispatcher's launch record id (`dispatch/lib/launches.ts`). */
export const LAUNCH_RECORD_ID_PATTERN = "^\\d{8}T\\d{6}Z-[a-f\\d]{8}$";

// ----------------------------------------------------------------- takeover

/** The takeover claim's own fields: who claims, from which clone. */
export const TAKEOVER_PAYLOAD_FIELDS = {
  actor: s.string(),
  clone: s.string(),
};
export const TAKEOVER_PAYLOAD_SHAPE = s.object(TAKEOVER_PAYLOAD_FIELDS);
/** The ledger generation a takeover claim names, a count from 0. */
export const TAKEOVER_GENERATION_SHAPE = s.integer({ minimum: 0 });
/**
 * A takeover claim written before claims carried the envelope: the claim's
 * fields alone, its generation and time among them, and no `kind`.
 */
export const TAKEOVER_LEGACY_SHAPE = s.object({
  ...TAKEOVER_PAYLOAD_FIELDS,
  generation: TAKEOVER_GENERATION_SHAPE,
  at: s.string(),
  kind: s.optional(s.never()),
});

// ------------------------------------------------------------------- launch

const DIED_END_SHAPE = s.object({
  state: s.literal("died"),
  at: s.string(),
  reason: s.string(),
  executed: s.optional(s.literal(false)),
});
const ENDED_END_SHAPE = s.object({
  state: s.literal("ended"),
  at: s.string(),
  exit: s.nullable(s.integer()),
  outcome: s.optional(
    s.nullable(s.enum(Object.keys(FOLLOWUP_OUTCOMES.tick) as TickOutcome[])),
  ),
  // Read only where they name a known writer and cause; any other reads as absent.
  by: s.optional(s.unknown()),
  cause: s.optional(s.unknown()),
});
/** An end with the time it ended, whatever its state: an end without one does not read. */
export const LAUNCH_END_TIME_SHAPE = s.object({ at: s.string() });
/** Each end state's form, by the state its `state` field names. */
export const LAUNCH_END_STATE_SHAPES = {
  ended: ENDED_END_SHAPE,
  died: DIED_END_SHAPE,
} as const satisfies Readonly<Record<LaunchEndState, Shape>>;
/** How a launch ended, in one of the end states. */
export const LAUNCH_END_SHAPE = s.union([ENDED_END_SHAPE, DIED_END_SHAPE]);

/**
 * The launch claim's own fields beside the pull request it names, in the
 * order its reader reports the first that does not read.
 */
export const LAUNCH_PAYLOAD_FIELDS = {
  action: s.enum(Object.keys(LAUNCH_CLAIM_VALUES.action) as LaunchAction[]),
  record: s.string({ pattern: LAUNCH_RECORD_ID_PATTERN }),
  host: s.string({ minLength: 1 }),
  facts: s.string(),
  change: s.optional(s.string()),
  earlier: s.optional(s.array(s.string())),
  owner: s.optional(s.boolean()),
  // Written only as true; any other value reads as false.
  conflictStop: s.optional(s.unknown()),
  end: s.optional(LAUNCH_END_SHAPE),
};
export const LAUNCH_PAYLOAD_SHAPE = s.object(LAUNCH_PAYLOAD_FIELDS);
/** The attempt a launch claim makes, from 1. */
export const LAUNCH_ATTEMPT_SHAPE = s.integer({ minimum: 1 });
/** The pull request a claim names, which its reader holds to the one it is on. */
export const CLAIM_PR_SHAPE = s.integer({ minimum: 1 });

// -------------------------------------------------------------- merge-ready

/** The announcement carries no field of its own: its key names the head. */
export const MERGE_READY_PAYLOAD_SHAPE = s.object({});
