/**
 * The JSON fields of mailbox lines. Readers and the Protocol's JSON Schemas
 * use these descriptions; timestamp parsing and pull-request scoping remain
 * checks of what a line means after its fields have been read.
 */
import { type Infer, s } from "../../../../../shared/shapes.ts";
import {
  DIRECTIVE_COMMANDS,
  GATE_NAMES,
  OUTBOX_STATUSES,
  type OutboxStatus,
} from "./mailbox-values.ts";

const text = s.string({ minLength: 1 });
const generation = s.integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const absent = s.optional(s.never());
const inboxBase = { id: text, ts: text, from: text, pr: text };
const outboxBase = { id: text, ts: text, pr: text };
const directiveBase = {
  ...inboxBase,
  kind: s.literal("directive"),
  body: s.optional(s.string()),
};

export const NOTE_MESSAGE_SHAPE = s.object({
  ...inboxBase,
  kind: s.literal("note"),
  body: s.string(),
  command: absent,
  target: absent,
  generation: absent,
});

/** Fields available to a directive's callers, with command-specific rules below. */
export const DIRECTIVE_MESSAGE_FIELDS_SHAPE = s.object({
  ...directiveBase,
  command: s.enum(DIRECTIVE_COMMANDS),
  target: s.optional(s.enum(GATE_NAMES)),
  generation: s.optional(generation),
  now: s.optional(s.literal(true)),
});

export const DIRECTIVE_MESSAGE_SHAPE = s.union([
  s.object({
    ...directiveBase,
    command: s.enum(
      DIRECTIVE_COMMANDS.filter((c) => c !== "stop" && c !== "resume"),
    ),
    target: absent,
    generation: absent,
    now: absent,
  }),
  s.object({
    ...directiveBase,
    command: s.literal("resume"),
    target: s.enum(GATE_NAMES),
    generation: absent,
    now: absent,
  }),
  s.object({
    ...directiveBase,
    command: s.literal("stop"),
    target: absent,
    generation: absent,
    now: absent,
  }),
  s.object({
    ...directiveBase,
    command: s.literal("stop"),
    target: absent,
    generation,
    now: s.optional(s.literal(true)),
  }),
]);

/** One line a sender writes to the inbox. Unknown fields remain ignored. */
export const MAILBOX_MESSAGE_SHAPE = s.union([
  NOTE_MESSAGE_SHAPE,
  DIRECTIVE_MESSAGE_SHAPE,
]);

/** Fields available to an outbox caller, with status-specific rules below. */
export const OUTBOX_RECORD_FIELDS_SHAPE = s.object({
  ...outboxBase,
  status: s.enum(Object.keys(OUTBOX_STATUSES) as OutboxStatus[]),
  response: s.optional(s.string()),
  generation: s.optional(generation),
});

export const MAILBOX_OUTBOX_SHAPE = s.union([
  s.object({ ...outboxBase, status: s.literal("received"), response: absent }),
  s.object({ ...outboxBase, status: s.literal("done"), response: text }),
  s.object({
    ...outboxBase,
    status: s.literal("ack"),
    generation,
    response: absent,
  }),
]);

export type NoteMessage = Infer<typeof NOTE_MESSAGE_SHAPE>;
export type DirectiveMessage = Infer<typeof DIRECTIVE_MESSAGE_FIELDS_SHAPE>;
export type InboxMessage = NoteMessage | DirectiveMessage;
export type OutboxRecord = Infer<typeof OUTBOX_RECORD_FIELDS_SHAPE>;
