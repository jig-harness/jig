/**
 * The closed values of the drive mailbox (`mailbox.ts`): the kinds of message
 * a sender appends to the inbox, the directives a `directive` message
 * carries, the statuses of the outbox's records, and the fields of each
 * file's lines, each with what it means to a reader. The mailbox's parsers,
 * its command line and `jig send` take their lists from these tables; the
 * Jig Protocol's chapter on the drive mailbox (`plugin/protocol/mailbox.md`)
 * is generated from them.
 *
 * Nothing here imports anything, so the chapter's generator reads the tables
 * without loading the mailbox.
 */

/** A value of one of the tables, with what it means to a reader that branches on it. */
export interface MailboxValue {
  readonly meaning: string;
}

/** The kinds of line a sender appends to `inbox.jsonl`, in its `kind` field. */
export const MESSAGE_KINDS = {
  note: {
    meaning:
      "Context for the drive's passes, which they may read (`mailbox.ts check`) and acknowledge; it never controls the drive. A note that lacks a field a note always carries is dropped with a warning; a line that is not valid JSON, or a note that carries `command`, `target` or `generation`, is read as a malformed directive and holds the drive's pushes.",
  },
  directive: {
    meaning:
      "A command the drive enforces mechanically, named in its `command` field. A directive line that does not parse holds the drive's pushes and ends the driver at its next checkpoint with exit 1, as an unreadable inbox does, and a re-armed drive ends again until a person repairs the file (`mailbox.ts repair`).",
  },
} as const satisfies Readonly<Record<string, MailboxValue>>;

export type MessageKind = keyof typeof MESSAGE_KINDS;

/** A directive's command, and whether `resume` may name it as its target. */
export interface DirectiveValue extends MailboxValue {
  readonly resumable: boolean;
}

/**
 * The commands a `directive` carries in its `command` field. For each of
 * `hold-push`, `pause` and `stop`, the latest directive in the inbox wins,
 * and a `resume` naming it as its `target` clears it.
 */
export const MAILBOX_DIRECTIVES = {
  "hold-push": {
    resumable: true,
    meaning:
      "Holds every push the drive makes through `guarded-push.ts`: the push is refused with exit 17 (`PUSH_HELD`) until a `resume` with target `hold-push`. The drive goes on with its rounds.",
  },
  pause: {
    resumable: true,
    meaning:
      "Holds the driver at its next checkpoint, keeping its locks, until a `resume` with target `pause`; one that lasts past `DRIVE_PR_PAUSE_MAX_SEC` ends the drive with exit 19 (`MAILBOX_PAUSE_TIMEOUT`).",
  },
  stop: {
    resumable: true,
    meaning:
      "Ends the driver at its next checkpoint with exit 18 (`MAILBOX_STOPPED`), after any running pass finishes; one that also carries `now` ends it at once, cancelling the running pass, with exit 143. One naming a `generation` ends that driver alone; one naming none ends every later driver in the working tree too, until a `resume` with target `stop`.",
  },
  resume: {
    resumable: false,
    meaning:
      "Clears the directive its `target` names. With target `stop` it also withdraws every stop addressed to a generation.",
  },
} as const satisfies Readonly<Record<string, DirectiveValue>>;

export type DirectiveCommand = keyof typeof MAILBOX_DIRECTIVES;
/** The directives `resume` may target: never `resume` itself. */
export type GateName = {
  [C in DirectiveCommand]: (typeof MAILBOX_DIRECTIVES)[C]["resumable"] extends true
    ? C
    : never;
}[DirectiveCommand];

/** Every directive command, in the table's order. */
export const DIRECTIVE_COMMANDS = Object.keys(
  MAILBOX_DIRECTIVES,
) as readonly DirectiveCommand[];

/** The directives `resume` may target, in the table's order. */
export const GATE_NAMES = DIRECTIVE_COMMANDS.filter(
  (c) => MAILBOX_DIRECTIVES[c].resumable,
) as readonly GateName[];

/** Who appends a record of one outbox status. */
export type OutboxWriter = "pass" | "driver";

/** An outbox status, with the side of the drive that writes it. */
export interface OutboxStatusValue extends MailboxValue {
  readonly writer: OutboxWriter;
}

/** The statuses of the lines the drive's side appends to `outbox.jsonl`, in their `status` field. */
export const OUTBOX_STATUSES = {
  received: {
    writer: "pass",
    meaning:
      "A pass saw the inbox message the record's `id` names (`mailbox.ts ack`), and has not answered it; the message is no longer shown as unseen.",
  },
  done: {
    writer: "pass",
    meaning:
      "A pass answered the inbox message the record's `id` names (`mailbox.ts respond`); the answer is in `response`.",
  },
  ack: {
    writer: "driver",
    meaning:
      "The driver of the record's `generation` acted on the `stop` or `pause` directive the record's `id` names, so a sender sees the directive took effect.",
  },
} as const satisfies Readonly<Record<string, OutboxStatusValue>>;

export type OutboxStatus = keyof typeof OUTBOX_STATUSES;

/** Whether a line carries a field: on every line of that kind, on some, or never (absent). */
export type Carried = "always" | "sometimes";

/** The JSON type of a field's value. */
export type MailboxFieldType = "string" | "integer" | "boolean";

/** A field of a mailbox line: its type, which lines carry it, and what it says. */
export interface MailboxField<K extends string> extends MailboxValue {
  readonly type: MailboxFieldType;
  readonly carriedBy: Readonly<Partial<Record<K, Carried>>>;
}

/** The fields of an inbox line, by the message kinds that carry them: the parser reads no other, and refuses a line that lacks one its kind always carries. */
export const INBOX_FIELDS = {
  id: {
    type: "string",
    carriedBy: { note: "always", directive: "always" },
    meaning:
      "The message's identifier, unique in the inbox; an outbox record names it in its own `id`.",
  },
  ts: {
    type: "string",
    carriedBy: { note: "always", directive: "always" },
    meaning: "When the message was sent, as an ISO 8601 time.",
  },
  kind: {
    type: "string",
    carriedBy: { note: "always", directive: "always" },
    meaning: "One of the message kinds listed above.",
  },
  from: {
    type: "string",
    carriedBy: { note: "always", directive: "always" },
    meaning:
      "Who sent it: a person's or a session's name, as the sender gives it.",
  },
  pr: {
    type: "string",
    carriedBy: { note: "always", directive: "always" },
    meaning:
      "The number of the pull request the message is for, as nonzero decimal digits with no leading zero (`12`, never `012` or `0`); a drive reads only its own pull request's messages, and a directive whose `pr` is not in that form holds the drive's pushes.",
  },
  body: {
    type: "string",
    carriedBy: { note: "always", directive: "sometimes" },
    meaning: "The note's text, or a directive's reason.",
  },
  command: {
    type: "string",
    carriedBy: { directive: "always" },
    meaning: "One of the directives listed above.",
  },
  target: {
    type: "string",
    carriedBy: { directive: "sometimes" },
    meaning:
      "The directive a `resume` clears; carried by every `resume` and by no other directive.",
  },
  generation: {
    type: "integer",
    carriedBy: { directive: "sometimes" },
    meaning:
      "The driver generation a `stop` addresses, a positive whole number the driver prints at its start; only a `stop` carries it.",
  },
  now: {
    type: "boolean",
    carriedBy: { directive: "sometimes" },
    meaning:
      "Always `true` where present, and only beside a `generation`: the driver cancels its running pass at once rather than waiting for it, and exits 143 (`drives.ts --stop`).",
  },
} as const satisfies Readonly<Record<string, MailboxField<MessageKind>>>;

/** The fields of an outbox line, by the statuses that carry them: the parser reads no other, and refuses a line that lacks one its status always carries. */
export const OUTBOX_FIELDS = {
  id: {
    type: "string",
    carriedBy: { received: "always", done: "always", ack: "always" },
    meaning: "The `id` of the inbox message the record answers.",
  },
  ts: {
    type: "string",
    carriedBy: { received: "always", done: "always", ack: "always" },
    meaning: "When the record was written, as an ISO 8601 time.",
  },
  pr: {
    type: "string",
    carriedBy: { received: "always", done: "always", ack: "always" },
    meaning:
      "The number of the pull request the record is for: a record acknowledges only that pull request's message.",
  },
  status: {
    type: "string",
    carriedBy: { received: "always", done: "always", ack: "always" },
    meaning: "One of the outbox statuses listed above.",
  },
  response: {
    type: "string",
    carriedBy: { done: "always" },
    meaning: "A pass's answer, never empty; only a `done` record carries it.",
  },
  generation: {
    type: "integer",
    carriedBy: { ack: "always" },
    meaning: "The generation of the driver that acted on the directive.",
  },
} as const satisfies Readonly<Record<string, MailboxField<OutboxStatus>>>;
