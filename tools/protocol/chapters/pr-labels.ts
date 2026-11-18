/**
 * The chapter on the pull-request labels Jig writes and reads, generated from
 * the label projection's tables (`STATE_LABELS`, `COMMAND_LABELS`): the state
 * labels a drive, a follow-up and the dispatcher's tick keep current, and the
 * command labels a person adds for the tick to read.
 */
import {
  COMMAND_LABELS,
  DEFAULT_LABELS,
  STATE_LABELS,
} from "../../../plugin/shared/pr-labels/projection.ts";
import {
  type Chapter,
  type DataValue,
  type FieldSpec,
  fromRows,
} from "../chapter.ts";
import { checkHeldPhrases } from "../held.ts";
import { table } from "../markdown.ts";

const SOURCE_FILE = "plugin/shared/pr-labels/projection.ts";

/** Entries of the label tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

interface Row {
  readonly table: "STATE_LABELS" | "COMMAND_LABELS";
  readonly value: DataValue;
}

function rows(): Row[] {
  const states: Row[] = Object.entries(STATE_LABELS).map(([name, v]) => ({
    table: "STATE_LABELS",
    value: {
      kind: "state",
      name,
      writers: v.writers.join(", "),
      meaning: v.meaning,
    },
  }));
  const commands: Row[] = Object.entries(COMMAND_LABELS).map(([name, v]) => ({
    table: "COMMAND_LABELS",
    value: { kind: "command", name, writers: null, meaning: v.meaning },
  }));
  return [...states, ...commands].filter(
    (r) =>
      !EXCLUDED.includes(`${SOURCE_FILE}#${r.table}.${String(r.value.name)}`),
  );
}

/** A label as a pull request carries it under the default prefix. */
const label = (v: DataValue) => `\`${DEFAULT_LABELS.prefix}${String(v.name)}\``;

function statesTable(): string {
  return table(
    ["Label", "Written by", "Meaning"],
    rows()
      .filter((r) => r.table === "STATE_LABELS")
      .map(({ value: v }) => [label(v), String(v.writers), String(v.meaning)]),
  );
}

function commandsTable(): string {
  return table(
    ["Label", "Meaning"],
    rows()
      .filter((r) => r.table === "COMMAND_LABELS")
      .map(({ value: v }) => [label(v), String(v.meaning)]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "state for a label that shows where a pull request's drive or follow-up stands, command for a label a person adds for the dispatcher to act on.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The label's name without the repository's prefix (dispatch.labels.prefix, jig: by default): a pull request carries the prefix followed by this name.",
  },
  writers: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    comparedAs: "names",
    description:
      "For a state label, who adds it, comma-separated: drive, followup (the follow-up of a merged pull request) and tick (the dispatcher's tick, which corrects every state label that disagrees with the pull request's drive ledger). Null for a command label, which only a person adds.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What the label says, as the label setup gives it as the label's description on the forge.",
  },
};

export const PR_LABELS: Chapter = {
  id: "pr-labels",
  check: (root) =>
    checkHeldPhrases(root, "pr-labels", [
      {
        file: "plugin/skills/drive-pr/SKILL.md",
        text: `The dispatcher's \`${DEFAULT_LABELS.prefix}${"hold" satisfies keyof typeof COMMAND_LABELS}\` label prevents new launches and re-arms`,
      },
    ]),
  title: "Pull-request labels Jig writes and reads",
  summary:
    "The labels that show where a pull request's drive or follow-up stands, and the labels a person adds to tell the dispatcher what to do with it.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/pr-labels.ts",
  sections: [
    { source: `${SOURCE_FILE}#STATE_LABELS`, render: statesTable },
    { source: `${SOURCE_FILE}#COMMAND_LABELS`, render: commandsTable },
  ],
  fields: FIELDS,
  ...fromRows(SOURCE_FILE, rows),
  excluded: EXCLUDED,
};
