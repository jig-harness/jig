/**
 * The chapter on the drive's end states and exit codes, generated from
 * drive-pr's terminal-state table (`TERMINAL_STATES`) and the exits
 * `drive.ts` ends with (`DRIVE_EXIT`).
 *
 * Sections cover the states and exits of `drive-status.ts` and `drive.ts`,
 * which share one numbering, and the exits the drive's helper scripts take
 * from that numbering, so that no code looks free while it is in use.
 */
import {
  DRIVE_EXIT,
  type DriveExitName,
  TERMINAL_STATES,
  type TerminalStateCategory,
  type TerminalStateEntry,
} from "../../../plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { code, flag, table } from "../markdown.ts";

const SOURCE_FILE =
  "plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";

/** The order of kinds among values that share a code. */
const KIND_ORDER: readonly TerminalStateCategory[] = [
  "state",
  "class-label",
  "tombstone",
  "driver-only",
  "helper",
];

/**
 * The round gate's go-ahead: `drive.ts` answers it by running a pass, so it
 * is never a code `drive.ts` ends with. Every other state `drive-status.ts`
 * reports, `drive.ts` ends with as it is, `CONVERGED` remapped.
 */
const GO_AHEAD = "ROUND_READY";

/** Entries of `TERMINAL_STATES` this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

interface Row {
  readonly name: string;
  readonly entry: TerminalStateEntry;
  readonly driveStatusExit: number | null;
  readonly driveExit: number | null;
}

const isDriveExitName = (name: string): name is DriveExitName =>
  Object.hasOwn(DRIVE_EXIT, name);

/** The code `drive.ts` ends with for an entry, or null when it never does. */
function driveExitOf(name: string, entry: TerminalStateEntry): number | null {
  if (isDriveExitName(name)) return DRIVE_EXIT[name];
  if (entry.category !== "state" || name === GO_AHEAD) return null;
  return entry.additionalExitCodes?.[0] ?? entry.exitCode;
}

/** The code `drive-status.ts` exits with for an entry, or null when it never does. */
function driveStatusExitOf(entry: TerminalStateEntry): number | null {
  return entry.category === "driver-only" ||
    entry.category === "helper" ||
    entry.category === "tombstone"
    ? null
    : entry.exitCode;
}

/** Every entry of the table, by code, then kind, then the table's own order. */
function rows(): Row[] {
  const all: Row[] = [];
  for (const [name, entry] of Object.entries(TERMINAL_STATES)) {
    if (entry === undefined || EXCLUDED.includes(name)) continue;
    all.push({
      name,
      entry,
      driveStatusExit: driveStatusExitOf(entry),
      driveExit: driveExitOf(name, entry),
    });
  }
  const order = (r: Row) => KIND_ORDER.indexOf(r.entry.category);
  return all
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        a.row.entry.exitCode - b.row.entry.exitCode ||
        order(a.row) - order(b.row) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

const driveRows = () => rows().filter((r) => r.entry.category !== "helper");
const helperRows = () => rows().filter((r) => r.entry.category === "helper");

function driveTable(): string {
  return table(
    [
      "State",
      "Kind",
      "`drive-status.ts` exits",
      "`drive.ts` exits",
      "Ends the drive",
      "Meaning",
    ],
    driveRows().map((r) => [
      `\`${r.name}\``,
      r.entry.category,
      code(r.driveStatusExit),
      code(r.driveExit),
      flag(r.entry.terminal),
      r.entry.meaning,
    ]),
  );
}

function helperTable(): string {
  return table(
    ["State", "Kind", "Exit", "Exited by", "Ends the drive", "Meaning"],
    helperRows().map((r) => [
      `\`${r.name}\``,
      r.entry.category,
      code(r.entry.exitCode),
      r.entry.emittedBy,
      flag(r.entry.terminal),
      r.entry.meaning,
    ]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The state's name as a drive-status.ts --json report's state field carries it, or the name of a class of states, a withdrawn code or an exit with no report.",
  },
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "state, class-label, tombstone, driver-only or helper, as the code names its categories.",
  },
  exit: {
    type: "integer",
    nullable: false,
    required: true,
    identifies: true,
    description: "The code this entry holds in the drive's numbering.",
  },
  driveStatusExit: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The code drive-status.ts exits with for it; null when drive-status.ts never does. Not part of identity: a withdrawn code keeps its row with this null.",
  },
  driveExit: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The code drive.ts ends with for it; null when drive.ts never does.",
  },
  endsDrive: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "Whether it ends the drive without the caller re-arming it on its own; null for a withdrawn code.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What it means to a reader that branches on it, and what that reader does next.",
  },
};

export const DRIVE_EXITS: Chapter = {
  id: "drive-exits",
  title: "Drive end states and exit codes",
  summary:
    "How a drive, or one round of it, ended: each state and the exit code `drive-status.ts` and `drive.ts` report it with.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/drive-exits.ts",
  sections: [
    {
      source: `${SOURCE_FILE}#TERMINAL_STATES,DRIVE_EXIT`,
      render: driveTable,
    },
    { source: `${SOURCE_FILE}#TERMINAL_STATES`, render: helperTable },
  ],
  fields: FIELDS,
  values: (): DataValue[] =>
    rows().map((r) => ({
      name: r.name,
      kind: r.entry.category,
      exit: r.entry.exitCode,
      driveStatusExit: r.driveStatusExit,
      driveExit: r.driveExit,
      endsDrive: r.entry.terminal,
      meaning: r.entry.meaning,
    })),
  takes: () => rows().map((r) => `${SOURCE_FILE}#TERMINAL_STATES.${r.name}`),
  excluded: EXCLUDED,
};
