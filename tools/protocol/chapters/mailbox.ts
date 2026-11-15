/**
 * The chapter on the drive mailbox, generated from the mailbox's tables
 * (`mailbox-values.ts`): the kinds of message a sender writes to a running
 * drive, the directives it enforces, the statuses of the drive's answers,
 * and the fields of both files' lines.
 */
import {
  MAILBOX_DIRECTIVES,
  INBOX_FIELDS,
  MESSAGE_KINDS,
  OUTBOX_FIELDS,
  OUTBOX_STATUSES,
} from "../../../plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts";
import {
  type Chapter,
  type DataValue,
  type FieldSpec,
  fromRows,
} from "../chapter.ts";
import { checkHeldPhrases } from "../held.ts";
import { TERMINAL_STATES } from "../../../plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { flag, table } from "../markdown.ts";

const SOURCE_FILE =
  "plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts";

/** The tables the chapter takes, with the kind each value is listed as. */
const TABLES = {
  MESSAGE_KINDS: "message-kind",
  MAILBOX_DIRECTIVES: "directive",
  OUTBOX_STATUSES: "outbox-status",
  INBOX_FIELDS: "inbox-field",
  OUTBOX_FIELDS: "outbox-field",
} as const;

type TableName = keyof typeof TABLES;

/** Entries of the mailbox's tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

/** Which lines carry a field, as one cell: `note (always), directive (sometimes)`. */
const carried = (by: Readonly<Record<string, string | undefined>>): string =>
  Object.entries(by)
    .map(([line, how]) => `${line} (${how})`)
    .join(", ");

interface Row {
  readonly table: TableName;
  readonly value: DataValue;
}

function rows(): Row[] {
  const out: Row[] = [];
  const push = (table: TableName, value: DataValue) => {
    if (!EXCLUDED.includes(`${SOURCE_FILE}#${table}.${value.name}`))
      out.push({ table, value });
  };
  const base = {
    resumable: null,
    writer: null,
    type: null,
    carriedBy: null,
  };
  for (const [name, v] of Object.entries(MESSAGE_KINDS))
    push("MESSAGE_KINDS", {
      kind: TABLES.MESSAGE_KINDS,
      name,
      ...base,
      meaning: v.meaning,
    });
  for (const [name, v] of Object.entries(MAILBOX_DIRECTIVES))
    push("MAILBOX_DIRECTIVES", {
      kind: TABLES.MAILBOX_DIRECTIVES,
      name,
      ...base,
      resumable: v.resumable,
      meaning: v.meaning,
    });
  for (const [name, v] of Object.entries(OUTBOX_STATUSES))
    push("OUTBOX_STATUSES", {
      kind: TABLES.OUTBOX_STATUSES,
      name,
      ...base,
      writer: v.writer,
      meaning: v.meaning,
    });
  for (const [name, v] of Object.entries(INBOX_FIELDS))
    push("INBOX_FIELDS", {
      kind: TABLES.INBOX_FIELDS,
      name,
      ...base,
      type: v.type,
      carriedBy: carried(v.carriedBy),
      meaning: v.meaning,
    });
  for (const [name, v] of Object.entries(OUTBOX_FIELDS))
    push("OUTBOX_FIELDS", {
      kind: TABLES.OUTBOX_FIELDS,
      name,
      ...base,
      type: v.type,
      carriedBy: carried(v.carriedBy),
      meaning: v.meaning,
    });
  return out;
}

const of = (table: TableName) =>
  rows()
    .filter((r) => r.table === table)
    .map((r) => r.value);

const name = (v: DataValue) => `\`${v.name}\``;
const text = (v: DataValue, field: string) => String(v[field]);

function messagesTable(): string {
  return table(
    ["Kind", "Meaning"],
    of("MESSAGE_KINDS").map((v) => [name(v), text(v, "meaning")]),
  );
}

function directivesTable(): string {
  return table(
    ["Command", "`resume` may target it", "Meaning"],
    of("MAILBOX_DIRECTIVES").map((v) => [
      name(v),
      flag(v.resumable as boolean),
      text(v, "meaning"),
    ]),
  );
}

function statusesTable(): string {
  return table(
    ["Status", "Written by", "Meaning"],
    of("OUTBOX_STATUSES").map((v) => [
      name(v),
      text(v, "writer"),
      text(v, "meaning"),
    ]),
  );
}

const fieldsTable = (table_: "INBOX_FIELDS" | "OUTBOX_FIELDS") => () =>
  table(
    ["Field", "Type", "Carried by", "Meaning"],
    of(table_).map((v) => [
      name(v),
      text(v, "type"),
      text(v, "carriedBy"),
      text(v, "meaning"),
    ]),
  );

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "message-kind for a value of an inbox line's kind field, directive for a value of a directive's command field, outbox-status for a value of an outbox line's status field, inbox-field and outbox-field for a field of each file's lines.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description: "The value as a line carries it, or the field's name.",
  },
  resumable: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a directive, whether a resume directive may name it as its target; null for every other value.",
  },
  writer: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an outbox status, who appends a record of it: pass (one of the drive's passes) or driver (drive.ts itself); null for every other value.",
  },
  type: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, the JSON type of its value: string, integer or boolean; null for every other value.",
  },
  carriedBy: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, the kinds or statuses of the lines that carry it, each with always or sometimes, as `note (always), directive (sometimes)`; a line of a kind not named never carries it. Null for every other value.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What it means to a reader that writes or reads the mailbox, and what that reader does with it.",
  },
};

export const MAILBOX: Chapter = {
  id: "mailbox",
  check: (root) =>
    checkHeldPhrases(root, "mailbox", [
      ...(
        [
          "hold-push",
          "stop",
        ] as const satisfies readonly (keyof typeof MAILBOX_DIRECTIVES)[]
      ).map((command) => ({
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `--kind ${"directive" satisfies keyof typeof MESSAGE_KINDS} --from <you> --command ${command}`,
      })),
      ...(
        [
          "hold-push",
          "stop",
        ] as const satisfies readonly (keyof typeof MAILBOX_DIRECTIVES)[]
      ).map((command) => ({
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `--command ${"resume" satisfies keyof typeof MAILBOX_DIRECTIVES} --${"target" satisfies keyof typeof INBOX_FIELDS} ${command}`,
      })),
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `--command ${"stop" satisfies keyof typeof MAILBOX_DIRECTIVES} --${"generation" satisfies keyof typeof INBOX_FIELDS} <n>`,
      },
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `an \`${"ack" satisfies keyof typeof OUTBOX_STATUSES}\` of each\ndirective it acted on`,
      },
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `directive refuses the push (exit \`${TERMINAL_STATES.PUSH_HELD?.exitCode}\``,
      },
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `drive exits \`${TERMINAL_STATES.MAILBOX_PAUSE_TIMEOUT?.exitCode}\` and releases its`,
      },
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `A graceful stop exits \`${TERMINAL_STATES.MAILBOX_STOPPED?.exitCode}\``,
      },
    ]),
  title: "The drive mailbox",
  summary:
    "What a person or a tool may tell a running drive, and how the drive answers: the messages, directives and acknowledgements in a working tree's mailbox files.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/mailbox.ts",
  sections: [
    { source: `${SOURCE_FILE}#MESSAGE_KINDS`, render: messagesTable },
    { source: `${SOURCE_FILE}#MAILBOX_DIRECTIVES`, render: directivesTable },
    {
      source: `${SOURCE_FILE}#INBOX_FIELDS`,
      render: fieldsTable("INBOX_FIELDS"),
    },
    { source: `${SOURCE_FILE}#OUTBOX_STATUSES`, render: statusesTable },
    {
      source: `${SOURCE_FILE}#OUTBOX_FIELDS`,
      render: fieldsTable("OUTBOX_FIELDS"),
    },
  ],
  fields: FIELDS,
  ...fromRows(SOURCE_FILE, rows),
  excluded: EXCLUDED,
};
