/** The reflection events a store returns, described for readers and the Protocol schemas. */
import { type Infer, s } from "../../../../shared/shapes.ts";

export const EVENT_VERSION = 1;
export const KINDS = ["error", "opportunity", "unhelpful-content"] as const;
export const SEVERITIES = ["high", "medium", "low"] as const;
export const DECISIONS = [
  "approved",
  "implemented",
  "deferred",
  "dismissed",
  "escalated",
] as const;
const text = () => s.string({ pattern: "\\S" });
const nullableText = () => s.nullable(s.string());
const count = () => s.integer({ minimum: 1 });
export const EVENT_ID_SHAPE = s.string({
  pattern: "^(?:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}|drv-[0-9a-f]{32})$",
});
export const EVENT_TIME_SHAPE = s.string({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$",
});
export const EVENT_CLASS_SHAPE = s.string({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
});
export const SESSION_SHAPE = s.object({
  jig_version: nullableText(),
  skills: s.array(text()),
  harness: s.nullable(
    s.object({
      name: nullableText(),
      version: nullableText(),
      entrypoint: nullableText(),
      wrapper: nullableText(),
    }),
  ),
  model: nullableText(),
  mode: nullableText(),
  stated: s.array(s.string()),
});
export const CHANGE_SHAPE = s.object({
  repository: text(),
  branch: nullableText(),
  pull_request: s.nullable(count()),
  issue: nullableText(),
});
export const TARGET_SHAPE = s.union([
  s.object({ scope: s.literal("repository"), name: text() }),
  s.object({ scope: s.literal("tool"), tool: text(), name: text() }),
]);
const base = {
  v: s.literal(EVENT_VERSION),
  id: EVENT_ID_SHAPE,
  at: EVENT_TIME_SHAPE,
  session: SESSION_SHAPE,
};
export const FINDING_EVENT_SHAPE = s.object({
  ...base,
  type: s.literal("finding"),
  change: CHANGE_SHAPE,
  kind: s.enum(KINDS),
  severity: s.enum(SEVERITIES),
  class: EVENT_CLASS_SHAPE,
  target: TARGET_SHAPE,
  title: text(),
  description: text(),
  suggested_fix: text(),
  time_cost_minutes: s.optional(s.number({ minimum: 0 })),
});
const decision = {
  ...base,
  type: s.literal("decision"),
  finding: EVENT_ID_SHAPE,
  reason: text(),
  commit: s.optional(text()),
  pull_request: s.optional(s.nullable(count())),
};
export const DECISION_EVENT_SHAPE = s.union([
  s.object({
    ...decision,
    decision: s.enum(["approved", "implemented", "deferred", "dismissed"]),
    issue: s.optional(text()),
  }),
  s.object({ ...decision, decision: s.literal("escalated"), issue: text() }),
]);
export const REFLECTION_EVENT_SHAPE = s.union([
  FINDING_EVENT_SHAPE,
  DECISION_EVENT_SHAPE,
]);
export type Session = Infer<typeof SESSION_SHAPE>;
export type Change = Infer<typeof CHANGE_SHAPE>;
export type Target = Infer<typeof TARGET_SHAPE>;
export type FindingEvent = Infer<typeof FINDING_EVENT_SHAPE>;
export type DecisionEvent = Infer<typeof DECISION_EVENT_SHAPE>;
export type ReflectionEvent = Infer<typeof REFLECTION_EVENT_SHAPE>;
