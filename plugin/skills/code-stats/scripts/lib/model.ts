/** The dimensions every tracked file is classified along, and its counts. */

/** What a file is. */
export const KINDS = [
  "code",
  "test",
  "docs",
  "config",
  "data",
  "generated",
  "fixture",
  "asset",
  "vendored",
  "other",
] as const;
export type Kind = (typeof KINDS)[number];

export function isKind(value: unknown): value is Kind {
  return (KINDS as readonly unknown[]).includes(value);
}

/** One dimension's value and the rule or detector that set it. */
export interface Decision<T extends string = string> {
  value: T;
  rule: string;
}

/** How one file was classified, each dimension with its deciding rule. */
export interface Classification {
  area: Decision;
  /** False when no area rule matched and the file fell to the default area. */
  areaMatched: boolean;
  kind: Decision<Kind>;
  language: Decision;
  module: Decision;
}

export interface FileStats {
  path: string;
  area: string;
  kind: Kind;
  language: string;
  module: string;
  /** False when no area rule matched and the file fell to the default area. */
  areaMatched: boolean;
  bytes: number;
  rawLines: number;
  blankLines: number;
  commentLines: number;
  codeLines: number;
}

/** Kind `other`, or an area no rule chose: what the reports call unclassified. */
export function isUnclassified(f: FileStats): boolean {
  return f.kind === "other" || !f.areaMatched;
}
