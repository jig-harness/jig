/** The ledger's JSON fields, shared by its reader and the stable marker schema. */
import { type Infer, s } from "../../../../../shared/shapes.ts";
import { AUTONOMY_LEVELS } from "../../../../../shared/autonomy-values.ts";
import type { ProbeStop } from "../status/probe-stop.ts";
import { ANSWER_FORM_NAMES } from "../../../../../shared/decisions/decision-values.ts";

import {
  TAKEOVER_VERDICTS,
  DECISION_CLASSES,
  EVENT_CAUSES,
  ARBITER_VERDICTS,
} from "./ledger-values.ts";

const text = s.string();
const nonempty = s.string({ minLength: 1 });
const key = s.string({ minLength: 1, pattern: "^[^\\r\\n]+$" });
// These existing ledger counters use Number.isInteger, without a safe-integer bound.
const count = s.integer({ minimum: 0, maximum: Number.MAX_VALUE });
const safeCount = s.integer({ minimum: 0 });
const digest = s.string({ pattern: "^[0-9a-f]{12}$" });
const absent = s.optional(s.never());
const texts = s.array(text);
const actor = s.string({ pattern: "^wt-[0-9a-f]{16}$" });

export const LEDGER_HELD_SHAPE = s.object({
  key: nonempty,
  kind: s.enum(["thread", "finding"]),
  round: s.integer({ minimum: -1, maximum: Number.MAX_VALUE }),
  actor: text,
  outcome: s.optional(s.enum(["accepted", "moot"])),
  commentUrl: s.optional(text),
  reason: s.optional(text),
  verifiedSha: s.optional(text),
});

export const LEDGER_DRIVER_SHAPE = s.object({
  actor: text,
  clone: text,
  heartbeat: text,
  state: s.enum(["running", "stopped"]),
  exit: s.optional(count),
  probe: s.optional(s.unknown()),
  personStop: s.optional(s.object({ at: text, reason: text })),
  recoveryVersion: s.optional(s.literal(1)),
  started: s.optional(text),
  position: s.optional(count),
});

export const LEDGER_CLAIM_REF_SHAPE = s.object({
  id: count,
  clone: text,
  generation: count,
});

const parked = s.object({
  key,
  kind: s.enum(["thread", "finding"]),
  reason: nonempty,
  round: count,
  person: s.optional(
    s.string({ pattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})(?:\\[bot\\])?$" }),
  ),
  at: s.optional(text),
  class: s.optional(s.string({ pattern: "^[a-z][a-z0-9-]*$" })),
  record: s.optional(s.string({ pattern: "\\S" })),
  // Framing belongs to the provisional needs chapter; the park reader checks it.
  decision: s.optional(s.object({})),
  digest: s.optional(digest),
});
const takeover = s.object({
  at: text,
  fromActor: s.nullable(actor),
  toActor: actor,
  verdict: s.enum(TAKEOVER_VERDICTS),
  round: count,
  reopened: s.array(key),
  reopenFailed: s.optional(s.array(key)),
  reconciled: s.optional(s.boolean()),
  vanishedTree: s.optional(nonempty),
});
const decisionBase = {
  at: text,
  round: count,
  level: s.enum(AUTONOMY_LEVELS),
  what: s.string({ pattern: "^(?=[^\\r\\n]*\\S)[^\\r\\n]+$" }),
  record: text,
  reverse: s.string({ pattern: "^(?=[^\\r\\n]*\\S)[^\\r\\n]+$" }),
};
const reversed = s.optional(s.object({ at: text, by: text, url: text }));
const decision = s.union([
  s.object({
    ...decisionBase,
    class: s.enum(
      DECISION_CLASSES.filter(
        (v) => v !== "decide-provisional" && v !== "provisional-reply",
      ),
    ),
    key: absent,
    outcome: absent,
    reversed: absent,
  }),
  s.object({
    ...decisionBase,
    class: s.literal("decide-provisional"),
    key: s.string({ pattern: "^\\S+$" }),
    outcome: absent,
    reversed,
  }),
  s.object({
    ...decisionBase,
    class: s.literal("provisional-reply"),
    key: s.string({ pattern: "^\\S+$" }),
    outcome: s.enum(["rejected", "wont-fix", "deferred"]),
    reversed,
  }),
]);
const eventBase = { at: text, round: safeCount };
const event = s.union([
  s.object({
    ...eventBase,
    kind: s.literal("restart"),
    cause: s.enum(EVENT_CAUSES.restart),
    leftWork: absent,
    tree: absent,
  }),
  s.object({
    ...eventBase,
    kind: s.literal("rearm"),
    cause: s.enum(EVENT_CAUSES.rearm),
    leftWork: absent,
    tree: absent,
  }),
  s.object({
    ...eventBase,
    kind: s.literal("stop"),
    cause: s.string({ pattern: "^(\\d+|unknown)$" }),
    leftWork: s.optional(s.boolean()),
    tree: s.optional(nonempty),
    // Readers validate reviewer evidence before using it. The open ledger
    // shape accepts extensions independently of whether they are usable.
    reviewerHead: s.optional(s.unknown()),
    reviewerApp: s.optional(s.unknown()),
    until: s.optional(s.unknown()),
    probe: s.optional(s.unknown()),
  }),
]);
const ciAction = s.object({
  at: text,
  round: safeCount,
  action: s.enum(["rerun", "repair"]),
  detail: s.string({ minLength: 1, maxLength: 1024 }),
});
const rulingBase = {
  key,
  contextAt: s.optional(text),
  round: s.number(),
  at: text,
};
const ruling = s.union([
  s.object({
    ...rulingBase,
    verdict: s.enum(ARBITER_VERDICTS.filter((v) => v !== "escalate")),
    class: absent,
    humanDecision: s.literal(false),
  }),
  s.object({
    ...rulingBase,
    verdict: s.literal("escalate"),
    class: nonempty,
    humanDecision: s.literal(false),
  }),
  s.object({
    ...rulingBase,
    verdict: s.literal("escalate"),
    class: s.literal("human-decision"),
    humanDecision: s.literal(true),
  }),
]);
const choice = s.object({
  option: text,
  recommended: s.boolean(),
  form: s.enum(ANSWER_FORM_NAMES),
  digest: s.optional(digest),
  note: s.optional(text),
});
const answer = s.object({
  author: text,
  at: text,
  url: text,
  bodyHash: s.optional(text),
  digest: s.optional(digest),
  stale: s.optional(s.literal(true)),
  choice: s.optional(choice),
});
const receipt = s.object({
  key: nonempty,
  kind: s.enum(["thread", "finding"]),
  reason: text,
  class: s.optional(text),
  digest: s.optional(digest),
  parkedAt: text,
  outcome: s.enum(["answered", "provisional"]),
  answers: s.array(answer),
  answeredAt: s.optional(text),
  resolvedAt: text,
  repairStartedAt: s.optional(text),
});

/** Every parsed field, so the reader can report the field that failed. */
export const LEDGER_PAYLOAD_FIELDS = {
  ledgerVersion: s.optional(s.enum([1, 2])),
  generation: s.integer({ minimum: 1, maximum: Number.MAX_VALUE }),
  pr: count,
  round: count,
  attempts: count,
  attemptsHead: text,
  deadlineRetries: count,
  // Published unrestricted, as the stable ledger accepted it before the field
  // existed; the reader checks it is a whole number (`ledger.ts`).
  roundsGranted: s.optional(s.unknown()),
  phase: text,
  lastCountedHead: text,
  verifiedSha: text,
  readyMarkedRound: count,
  parked: s.array(parked),
  held: s.array(LEDGER_HELD_SHAPE),
  // Existing readers accept any object here; seeding does not import the quota park.
  quotaPark: s.nullable(s.object({})),
  takeovers: s.array(takeover),
  claims: s.array(LEDGER_CLAIM_REF_SHAPE),
  decisions: s.array(decision),
  events: s.optional(s.array(event)),
  ciActions: s.optional(s.array(ciAction, { maxItems: 10 })),
  rulings: s.optional(s.array(ruling)),
  resolvedParks: s.optional(s.array(receipt)),
  driver: LEDGER_DRIVER_SHAPE,
  narrative: texts,
  cut: texts,
} as const;

/** The envelope supplies generation and may supply ledgerVersion from its v. */
export const LEDGER_PAYLOAD_SHAPE = s.object(LEDGER_PAYLOAD_FIELDS);
export type LedgerHeld = Infer<typeof LEDGER_HELD_SHAPE>;
export type LedgerDriver = Omit<Infer<typeof LEDGER_DRIVER_SHAPE>, "probe"> & {
  probe?: ProbeStop;
};
export type LedgerClaimRef = Infer<typeof LEDGER_CLAIM_REF_SHAPE>;
