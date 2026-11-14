/**
 * The mailbox's tables (`mailbox-values.ts`) state what its parsers read:
 * each field a line of a kind or status always carries is one the parser
 * refuses the line without, each field the table says a line may carry
 * reaches the parsed record on some line, and no other field does. The Jig
 * Protocol's mailbox chapter is generated from these tables, so a parser that
 * reads another shape fails here before the chapter misstates it.
 */
import { describe, expect, test } from "bun:test";
import {
  parseInboxMessage,
  parseOutboxRecord,
} from "../scripts/lib/state/mailbox.ts";
import {
  DIRECTIVE_COMMANDS,
  MAILBOX_DIRECTIVES,
  GATE_NAMES,
  INBOX_FIELDS,
  MESSAGE_KINDS,
  OUTBOX_FIELDS,
  OUTBOX_STATUSES,
} from "../scripts/lib/state/mailbox-values.ts";

const AT = "2026-01-01T00:00:00.000Z";
const line = { id: "m1", ts: AT, from: "person", pr: "12" };

/** Every shape of inbox line the parser accepts, by kind. */
const INBOX_LINES: Record<string, Record<string, unknown>[]> = {
  note: [{ ...line, kind: "note", body: "context" }],
  directive: [
    { ...line, kind: "directive", command: "hold-push" },
    { ...line, kind: "directive", command: "pause", body: "why" },
    { ...line, kind: "directive", command: "stop", generation: 3 },
    { ...line, kind: "directive", command: "stop", generation: 3, now: true },
    { ...line, kind: "directive", command: "resume", target: "stop" },
  ],
};

/** Every shape of outbox line the parser accepts, by status. */
const OUTBOX_LINES: Record<string, Record<string, unknown>[]> = {
  received: [{ id: "m1", ts: AT, pr: "12", status: "received" }],
  done: [{ id: "m1", ts: AT, pr: "12", status: "done", response: "ok" }],
  ack: [{ id: "m1", ts: AT, pr: "12", status: "ack", generation: 2 }],
};

/** The fields a table says lines of `kind` carry, always or sometimes. */
function carriedBy(
  fields: Readonly<
    Record<string, { carriedBy: Readonly<Record<string, string>> }>
  >,
  kind: string,
  how?: string,
): string[] {
  return Object.entries(fields)
    .filter(([, f]) => {
      const c = f.carriedBy[kind];
      return c !== undefined && (how === undefined || c === how);
    })
    .map(([name]) => name);
}

function holdsTo(
  fields: Parameters<typeof carriedBy>[0],
  lines: Record<string, Record<string, unknown>[]>,
  parse: (v: unknown) => object | null,
) {
  for (const [kind, shapes] of Object.entries(lines)) {
    const read = shapes.map((s) => parse(s));
    test(`${kind}: the parser accepts every listed shape`, () => {
      expect(read.every((r) => r !== null)).toBe(true);
    });
    test(`${kind}: the parsed record carries the fields the table lists, and no other`, () => {
      const seen = new Set(read.flatMap((r) => Object.keys(r ?? {})));
      expect([...seen].sort()).toEqual(carriedBy(fields, kind).sort());
    });
    test(`${kind}: the parser refuses a line without a field the table says it always carries`, () => {
      for (const field of carriedBy(fields, kind, "always"))
        for (const shape of shapes) {
          const { [field]: _, ...without } = shape;
          expect({ field, read: parse(without) }).toEqual({
            field,
            read: null,
          });
        }
    });
  }
}

describe("the inbox fields", () => {
  test("cover every message kind, and only those", () => {
    expect(Object.keys(INBOX_LINES)).toEqual(Object.keys(MESSAGE_KINDS));
    for (const f of Object.values(INBOX_FIELDS))
      for (const kind of Object.keys(f.carriedBy))
        expect(Object.keys(MESSAGE_KINDS)).toContain(kind);
  });
  holdsTo(INBOX_FIELDS, INBOX_LINES, parseInboxMessage);
});

describe("the outbox fields", () => {
  test("cover every outbox status, and only those", () => {
    expect(Object.keys(OUTBOX_LINES)).toEqual(Object.keys(OUTBOX_STATUSES));
    for (const f of Object.values(OUTBOX_FIELDS))
      for (const status of Object.keys(f.carriedBy))
        expect(Object.keys(OUTBOX_STATUSES)).toContain(status);
  });
  holdsTo(OUTBOX_FIELDS, OUTBOX_LINES, parseOutboxRecord);
});

describe("the directives", () => {
  test("are the commands the parser reads, and an unlisted one is refused", () => {
    for (const command of DIRECTIVE_COMMANDS) {
      const shape =
        command === "resume"
          ? { ...line, kind: "directive", command, target: "pause" }
          : { ...line, kind: "directive", command };
      expect(parseInboxMessage(shape)).not.toBeNull();
    }
    expect(
      parseInboxMessage({ ...line, kind: "directive", command: "restart" }),
    ).toBeNull();
    expect(DIRECTIVE_COMMANDS).toEqual(
      Object.keys(MAILBOX_DIRECTIVES) as typeof DIRECTIVE_COMMANDS,
    );
  });

  test("that resume may target are exactly the resumable ones", () => {
    for (const target of DIRECTIVE_COMMANDS) {
      const read = parseInboxMessage({
        ...line,
        kind: "directive",
        command: "resume",
        target,
      });
      expect({ target, accepted: read !== null }).toEqual({
        target,
        accepted: MAILBOX_DIRECTIVES[target].resumable,
      });
    }
    expect<readonly string[]>(GATE_NAMES).toEqual(
      DIRECTIVE_COMMANDS.filter((c) => MAILBOX_DIRECTIVES[c].resumable),
    );
  });
});
