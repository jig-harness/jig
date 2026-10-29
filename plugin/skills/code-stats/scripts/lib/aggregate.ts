/**
 * Totals and breakdowns, and the `--json` report built from them. The JSON
 * shape is versioned by its `schema` field: a change that renames or removes
 * a field, or changes what one means, is a new version.
 */
import { type FileStats, isUnclassified, type Kind } from "./model.ts";
import type { Reading, Unreadable } from "./test-runners/index.ts";

export const JSON_SCHEMA = "code-stats/v1";

export interface Bucket {
  files: number;
  bytes: number;
  raw: number;
  code: number;
  comment: number;
  blank: number;
}

export function emptyBucket(): Bucket {
  return { files: 0, bytes: 0, raw: 0, code: 0, comment: 0, blank: 0 };
}

export function addTo(bucket: Bucket, f: FileStats): void {
  bucket.files++;
  bucket.bytes += f.bytes;
  bucket.raw += f.rawLines;
  bucket.code += f.codeLines;
  bucket.comment += f.commentLines;
  bucket.blank += f.blankLines;
}

export function total(files: readonly FileStats[]): Bucket {
  const bucket = emptyBucket();
  for (const f of files) addTo(bucket, f);
  return bucket;
}

export function groupBy(
  files: readonly FileStats[],
  key: (f: FileStats) => string,
): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const f of files) {
    const k = key(f);
    let bucket = map.get(k);
    if (!bucket) {
      bucket = emptyBucket();
      map.set(k, bucket);
    }
    addTo(bucket, f);
  }
  return map;
}

/** A share as a fraction from 0 to 1, rounded to four decimals; 0 of 0 is 0. */
export function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;
}

/** Files of kind `other`, or whose area no rule chose. */
export interface Unclassified {
  files: number;
  codeLines: number;
  filesShare: number;
  codeShare: number;
  kindOther: number;
  defaultArea: number;
}

/**
 * The unclassified share. `defaultArea` counts the files that fell through
 * to the default area because no area rule matched them; a file can be
 * counted in both that and `kindOther`, and once in `files`.
 */
export function unclassified(files: readonly FileStats[]): Unclassified {
  const these = files.filter(isUnclassified);
  const codeLines = these.reduce((a, f) => a + f.codeLines, 0);
  const allCode = files.reduce((a, f) => a + f.codeLines, 0);
  return {
    files: these.length,
    codeLines,
    filesShare: share(these.length, files.length),
    codeShare: share(codeLines, allCode),
    kindOther: files.filter((f) => f.kind === "other").length,
    defaultArea: files.filter((f) => !f.areaMatched).length,
  };
}

export interface ReportInput {
  generatedAt: string;
  repository: string;
  commit: string;
  branch: string;
  areas: readonly string[];
  areaDescriptions: Record<string, string>;
  defaultArea: string;
  kinds: readonly Kind[];
  /** The files the totals count (vendored ones only when asked for). */
  files: readonly FileStats[];
  vendoredExcluded: Bucket;
  includeVendored: boolean;
  missing: number;
  testRunners: TestRunnerSummary;
}

/** The test-runner configurations read, and those that could not be. */
export interface TestRunnerSummary {
  configurations: { reader: string; file: string }[];
  unreadable: Unreadable[];
}

/** Each configuration file that gave a rule, once, and every unreadable one. */
export function testRunnerSummary(reading: Reading): TestRunnerSummary {
  const seen = new Map<string, { reader: string; file: string }>();
  for (const { reader, file } of reading.rules)
    seen.set(`${reader}\0${file}`, { reader, file });
  return { configurations: [...seen.values()], unreadable: reading.unreadable };
}

const toObject = (map: Map<string, Bucket>) => Object.fromEntries(map);

/** In `order` first, then the rest by name: a stable key order for JSON. */
function ordered(
  map: Map<string, Bucket>,
  order: readonly string[] = [],
): Map<string, Bucket> {
  const keys = [
    ...order.filter((k) => map.has(k)),
    ...[...map.keys()].filter((k) => !order.includes(k)).sort(),
  ];
  return new Map(keys.map((k) => [k, map.get(k) as Bucket]));
}

/** The `--json` report. */
export function jsonReport(input: ReportInput) {
  const { files } = input;
  const totals = total(files);
  return {
    schema: JSON_SCHEMA,
    generatedAt: input.generatedAt,
    repository: input.repository,
    commit: input.commit,
    branch: input.branch,
    totals: {
      files: totals.files,
      bytes: totals.bytes,
      rawLines: totals.raw,
      codeLines: totals.code,
      commentLines: totals.comment,
      blankLines: totals.blank,
    },
    unclassified: unclassified(files),
    vendored: {
      included: input.includeVendored,
      excludedFiles: input.vendoredExcluded.files,
      excludedBytes: input.vendoredExcluded.bytes,
    },
    missingFromWorkingTree: input.missing,
    testRunners: input.testRunners,
    areas: input.areas.map((name) => ({
      name,
      description: input.areaDescriptions[name] ?? "",
      default: name === input.defaultArea,
    })),
    byArea: toObject(
      ordered(
        groupBy(files, (f) => f.area),
        input.areas,
      ),
    ),
    byKind: toObject(
      ordered(
        groupBy(files, (f) => f.kind),
        input.kinds,
      ),
    ),
    byLanguage: toObject(ordered(groupBy(files, (f) => f.language))),
    byModule: toObject(ordered(groupBy(files, (f) => f.module))),
    byAreaKind: toObject(ordered(groupBy(files, (f) => `${f.area}/${f.kind}`))),
  };
}
