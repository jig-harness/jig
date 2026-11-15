/**
 * The chapter on addresses and the verbs of `jig send`, generated from the
 * stations table (`STATIONS` in `shared/address.ts`) and the verb table
 * (`SEND_VERBS` in `send/lib/verb-values.ts`): the stations an address
 * names, with what each one's key is, and the verbs a person or a tool sends
 * to them.
 */
import { STATIONS } from "../../../plugin/shared/address.ts";
import { SEND_VERBS } from "../../../plugin/send/lib/verb-values.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { flag, table } from "../markdown.ts";

const STATIONS_FILE = "plugin/shared/address.ts";
const VERBS_FILE = "plugin/send/lib/verb-values.ts";

/** Entries of the two tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

/** What a station's key is, in a reader's words. */
const KEY_TEXT = {
  item: "the tracker's item key",
  "pull-request": "the pull request's number",
} as const;

interface Row {
  readonly entry: string;
  readonly value: DataValue;
}

function rows(): Row[] {
  const stations: Row[] = Object.entries(STATIONS).map(([name, v]) => ({
    entry: `${STATIONS_FILE}#STATIONS.${name}`,
    value: {
      kind: "station",
      name,
      key: v.key,
      stations: null,
      person: null,
      args: null,
      meaning: v.meaning,
    },
  }));
  const verbs: Row[] = Object.entries(SEND_VERBS).map(([name, v]) => ({
    entry: `${VERBS_FILE}#SEND_VERBS.${name}`,
    value: {
      kind: "verb",
      name,
      key: null,
      stations: v.stations.join(", "),
      person: v.person,
      args: v.args === "" ? null : v.args,
      meaning: v.meaning,
    },
  }));
  return [...stations, ...verbs].filter((r) => !EXCLUDED.includes(r.entry));
}

const of = (kind: string) =>
  rows()
    .map((r) => r.value)
    .filter((v) => v.kind === kind);

function stationsTable(): string {
  return table(
    ["Station", "Its key", "Meaning"],
    of("station").map((v) => [
      `\`${v.name}\``,
      KEY_TEXT[v.key as keyof typeof KEY_TEXT],
      String(v.meaning),
    ]),
  );
}

function verbsTable(): string {
  return table(
    ["Verb", "Arguments", "To", "A person's command", "Meaning"],
    of("verb").map((v) => [
      `\`${v.name}\``,
      v.args === null ? "—" : `\`${v.args}\``,
      String(v.stations)
        .split(", ")
        .map((s) => `\`${s}\``)
        .join(", "),
      flag(v.person as boolean),
      String(v.meaning),
    ]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "station for a station an address names, verb for a verb of jig send.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The station as an address writes it before its @, or the verb as jig send takes it after the address.",
  },
  key: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a station, what its address's key is: item for the tracker's item key, pull-request for a pull request's number. Null for a verb.",
  },
  stations: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a verb, the stations whose addresses take it, comma-separated. Null for a station.",
  },
  person: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a verb, whether it is a person's command, which jig send refuses in a session the line started. Null for a station.",
  },
  args: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a verb, the arguments it takes after the verb, as its usage names them; null for a verb that takes none, and for a station.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What holding the station means, or what sending the verb asks for.",
  },
};

export const ADDRESSES: Chapter = {
  id: "addresses",
  title: "Addresses and the verbs of `jig send`",
  summary:
    "The stations an address names on a piece of work, what each one's key is, and the verbs `jig send` tells a station.",
  version: 1,
  status: "provisional",
  planItems: [
    { item: 39, epic: 485 },
    { item: 42, epic: 541 },
  ],
  module: "tools/protocol/chapters/addresses.ts",
  sections: [
    { source: `${STATIONS_FILE}#STATIONS`, render: stationsTable },
    { source: `${VERBS_FILE}#SEND_VERBS`, render: verbsTable },
  ],
  fields: FIELDS,
  values: () => rows().map((r) => r.value),
  takes: () => rows().map((r) => r.entry),
  excluded: EXCLUDED,
};
