/**
 * The shape of a Jig Protocol chapter as the generator reads it
 * (design/protocol.md § The generator and its gate): what a chapter
 * declares in the chapter list (`chapters.ts`), and what its data file
 * (`plugin/protocol/data/<chapter>.json`) holds.
 */

/** Where the chapters, their index page and their data files live. */
export const PROTOCOL_DIR = "plugin/protocol";
export const DATA_DIR = `${PROTOCOL_DIR}/data`;
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

/** One field of a chapter's values, as its data file declares it. */
export interface FieldSpec {
  readonly type: FieldType;
  readonly nullable: boolean;
  /** Whether every value carries the field. */
  readonly required: boolean;
  /** Whether the field is part of what makes one value the same value at the base and now. */
  readonly identifies: boolean;
  readonly description: string;
}

export type Scalar = string | number | boolean | null;

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
}

export const chapterFile = (id: string): string => `${PROTOCOL_DIR}/${id}.md`;
export const dataFile = (id: string): string => `${DATA_DIR}/${id}.json`;

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
    fields: chapter.fields,
    values: chapter.values(),
  };
}

/**
 * The data file as text. Every object is expanded and no array holds plain
 * values, so the layout is the one Biome formats JSON to and the formatter
 * leaves the file as written.
 */
export const dataText = (data: DataFile): string =>
  `${JSON.stringify(data, null, 2)}\n`;
