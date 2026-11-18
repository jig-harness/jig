/**
 * The shape of a Jig Protocol chapter as the generator reads it
 * (design/protocol.md § The generator and its gate): what a chapter
 * declares in the chapter list (`chapters.ts`), and what its data file
 * (`plugin/protocol/data/<chapter>.json`) holds.
 */
import {
  type JsonSchema,
  type Shape,
  toJsonSchema,
} from "../../plugin/shared/shapes.ts";
import { jsonText } from "./json.ts";

import type { Finding } from "../../lib/findings.ts";

/** Where the chapters, their index page and their data files live. */
export const PROTOCOL_DIR = "plugin/protocol";
export const DATA_DIR = `${PROTOCOL_DIR}/data`;
export const SCHEMA_DIR = `${PROTOCOL_DIR}/schemas`;
export const INDEX_FILE = `${PROTOCOL_DIR}/README.md`;
/** The plan a provisional chapter's items must be open in. */
export const PLAN_FILE = "design/plan.md";
/** The command that regenerates every chapter, named in each finding. */
export const COMMAND = "bun tools/protocol/generate.ts";
/** Where a plan item's epic issue is read, from an installed plugin too. */
export const ISSUE_URL = "https://github.com/jig-harness/jig/issues/";
/** The source the index page's generated list names. */
export const INDEX_SOURCE = "tools/protocol/chapters.ts#CHAPTERS";

/** A plan item that still moves a provisional chapter, with its epic issue. */
export interface PlanItem {
  readonly item: number;
  readonly epic: number;
}

/** The JSON type of a data file field; `nullable` says whether `null` is allowed too. */
export type FieldType = "string" | "integer" | "boolean";

/**
 * How the comparison with the integration branch reads a change to a field's
 * content (design/protocol.md § What stable promises, and how the gate holds
 * it): `exact`, every change is a break; `prose`, words for a person, which
 * may be reworded but not emptied, nor stated where a value held null;
 * `names`, a comma-separated list of names, which may gain a name, in any
 * order, and not lose one; `carriers`, what carries a value, each with always
 * or sometimes, which a carrier the base names joins or leaves only as
 * sometimes.
 */
export type FieldComparison = "exact" | "prose" | "names" | "carriers";

/** One field of a chapter's values, as its data file declares it. */
export interface FieldSpec {
  readonly type: FieldType;
  readonly nullable: boolean;
  /** Whether every value carries the field. */
  readonly required: boolean;
  /** Whether the field is part of what makes one value the same value at the base and now. */
  readonly identifies: boolean;
  /** How a change to its content is read; left out of a chapter's declaration, `comparisonOf` says. */
  readonly comparedAs?: FieldComparison;
  readonly description: string;
}

export type Scalar = string | number | boolean | null;

/**
 * What a `carriers` field names, each with `always` or `sometimes`
 * (`tick (always), manual (sometimes)`); an empty text names none; null
 * when the text is not that shape.
 */
export function carriedMap(
  text: Scalar | undefined,
): Map<string, string> | null {
  if (typeof text !== "string") return null;
  const carriers = new Map<string, string>();
  if (text === "") return carriers;
  for (const part of text.split(", ")) {
    const m = /^(\S+) \((always|sometimes)\)$/.exec(part);
    if (m === null || carriers.has(m[1] as string)) return null;
    carriers.set(m[1] as string, m[2] as string);
  }
  return carriers;
}

/** One value of a chapter, as its data file lists it. */
export type DataValue = Readonly<Record<string, Scalar>>;

/** One generated section: the source its marker names, and the Markdown between the markers. */
export interface Section {
  readonly source: string;
  render(): string;
}

export type ChapterStatus = "stable" | "provisional";

/** One chapter of the Protocol, as the chapter list declares it. */
export interface Chapter {
  /** The file's stem: `plugin/protocol/<id>.md` and `data/<id>.json`. */
  readonly id: string;
  readonly title: string;
  /** One sentence for the index page. */
  readonly summary: string;
  /** The chapter's own version, an integer from 1. */
  readonly version: number;
  readonly status: ChapterStatus;
  /** The plan items that still move a provisional chapter; none for a stable one. */
  readonly planItems: readonly PlanItem[];
  /** The module that defines its sections; every file it imports is a source of the inventory entry. */
  readonly module: string;
  readonly sections: readonly Section[];
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /** Every value the chapter lists, each with a non-empty `meaning`. */
  values(): readonly DataValue[];
  /** The entries of the code's tables the chapter takes (`<file>#<table>.<entry>`): no two chapters take one. */
  takes(): readonly string[];
  /** Entries of the imported tables the chapter deliberately leaves out. */
  readonly excluded: readonly string[];
  /** Held restatements and code bindings this chapter checks beside its generated values. */
  check?(root: string): readonly Finding[];
  /** The JSON documents this chapter publishes, derived from their readers' descriptions. */
  readonly schemas?: readonly {
    readonly name: string;
    readonly shape: Shape;
  }[];
}

/** A chapter removed from the list: the version it was withdrawn at, above the last it shipped. */
export interface Withdrawn {
  readonly id: string;
  readonly version: number;
}

/** A chapter's data file. */
export interface DataFile {
  readonly chapter: string;
  readonly title: string;
  readonly version: number;
  readonly status: ChapterStatus;
  readonly planItems?: readonly PlanItem[];
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly values: readonly DataValue[];
  /** The published document shapes, without publication addresses, for stable-base comparison. */
  readonly schemas?: Readonly<Record<string, JsonSchema>>;
}

export const chapterFile = (id: string): string => `${PROTOCOL_DIR}/${id}.md`;
export const dataFile = (id: string): string => `${DATA_DIR}/${id}.json`;
export const schemaFile = (name: string): string =>
  `${SCHEMA_DIR}/${name}.json`;

/** A published schema's address identifies the contract's chapter and version. */
export function schemaOf(chapter: Chapter, name: string, shape: Shape) {
  const schema = toJsonSchema(shape);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://jig-harness.dev/protocol/${chapter.id}/v${chapter.version}/schemas/${name}.json`,
    ...(typeof schema === "boolean" ? { allOf: [schema] } : schema),
  };
}

/** A field's comparison: its declared one, else prose for a value's `meaning` and exact for any other field. */
export const comparisonOf = (name: string, spec: FieldSpec): FieldComparison =>
  spec.comparedAs ?? (name === "meaning" ? "prose" : "exact");

/** A field as its data file publishes it, its comparison stated. */
function publishedField(name: string, spec: FieldSpec): FieldSpec {
  const { type, nullable, required, identifies, description } = spec;
  return {
    type,
    nullable,
    required,
    identifies,
    comparedAs: comparisonOf(name, spec),
    description,
  };
}

/** The chapter's data file, in the order its JSON lists the keys. */
export function dataOf(chapter: Chapter): DataFile {
  return {
    chapter: chapter.id,
    title: chapter.title,
    version: chapter.version,
    status: chapter.status,
    ...(chapter.status === "provisional"
      ? { planItems: chapter.planItems.map((p) => ({ ...p })) }
      : {}),
    fields: Object.fromEntries(
      Object.entries(chapter.fields).map(([name, spec]) => [
        name,
        publishedField(name, spec),
      ]),
    ),
    values: chapter.values(),
    ...((chapter.schemas?.length ?? 0) > 0
      ? {
          schemas: Object.fromEntries(
            (chapter.schemas ?? []).map(({ name, shape }) => [
              name,
              toJsonSchema(shape),
            ]),
          ),
        }
      : {}),
  };
}

/** A data file in the same format as every generated schema. */
export const dataText = (data: DataFile): string => jsonText(data);

/** One value of a chapter, with the table of `file` it comes from. */
export interface TableRow {
  readonly table: string;
  readonly value: DataValue;
}

/** A chapter's values and the entries it takes, from rows each naming its table and carrying a `name`. */
export function fromRows(
  file: string,
  rows: () => readonly TableRow[],
): Pick<Chapter, "values" | "takes"> {
  return {
    values: () => rows().map((r) => r.value),
    takes: () =>
      rows().map((r) => `${file}#${r.table}.${String(r.value.name)}`),
  };
}
