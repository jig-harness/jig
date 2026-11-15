/** The follow-up run shapes, including payloads kept from markers written before the envelope. */
import { s } from "../shapes.ts";
import { FOLLOWUP_OUTCOMES } from "./followup-values.ts";

const FOLLOWUP_RECORD_ID_SHAPE = s.string({
  pattern: "^\\d{8}T\\d{6}Z-[a-f\\d]{8}$",
});
const TICK_RUN_SHAPE = s.object({
  run: s.literal("tick"),
  record: FOLLOWUP_RECORD_ID_SHAPE,
  outcome: s.optional(s.enum(Object.keys(FOLLOWUP_OUTCOMES.tick))),
  // Optional telemetry predates validation; unusable values normalize to no answer.
  host: s.optional(s.unknown()),
  owner: s.optional(s.unknown()),
  endedAt: s.optional(s.unknown()),
});
const MANUAL_RUN_SHAPE = s.object({
  run: s.literal("manual"),
  outcome: s.enum(Object.keys(FOLLOWUP_OUTCOMES.manual)),
});
/** Only these run fields govern acceptance; optional telemetry is ignored if unusable. */
export const FOLLOWUP_RUN_SHAPE = s.union([TICK_RUN_SHAPE, MANUAL_RUN_SHAPE]);
export const FOLLOWUP_PAYLOAD_SHAPE = s.intersection(
  s.object({ pr: s.integer({ minimum: 1 }) }),
  FOLLOWUP_RUN_SHAPE,
);
