/**
 * The HTML report: ONE self-contained file. The per-file rows are
 * dictionary-encoded into a JSON blob and injected into the template
 * (`report.html` beside the scripts), whose inline script does every
 * aggregation in the browser, so the report filters, pivots and drills down
 * with no server and no network access.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CodeStatsError } from "./errors.ts";
import type { FileStats } from "./model.ts";

export interface HtmlConvention {
  ecosystem: string;
  rule: string;
  kind: string;
}

export interface HtmlReportInput {
  generatedAt: string;
  repository: string;
  commit: string;
  branch: string;
  areas: readonly string[];
  areaDescriptions: Record<string, string>;
  defaultArea: string;
  kinds: readonly string[];
  files: readonly FileStats[];
  vendoredExcluded: number;
  includeVendored: boolean;
  /** Tracked files missing from the working tree, so not in `files`. */
  missing: number;
  conventions: readonly HtmlConvention[];
}

/** Row layout shared with the template's script: keep the two in step. */
export type EncodedRow = [
  path: string,
  area: number,
  kind: number,
  language: number,
  module: number,
  bytes: number,
  raw: number,
  code: number,
  comment: number,
  blank: number,
  /** 1 when no area rule matched and the file fell to the default area. */
  fellThrough: 0 | 1,
];

export interface EncodedReport {
  generatedAt: string;
  repository: string;
  commit: string;
  branch: string;
  areas: string[];
  areaDescriptions: Record<string, string>;
  defaultArea: string;
  kinds: string[];
  languages: string[];
  modules: string[];
  vendoredExcluded: number;
  includeVendored: boolean;
  missingFromWorkingTree: number;
  conventions: HtmlConvention[];
  files: EncodedRow[];
}

const DATA_PLACEHOLDER = '"__CODE_STATS_DATA__"';
const TEMPLATE = resolve(import.meta.dir, "..", "report.html");

export function encodeReport(input: HtmlReportInput): EncodedReport {
  const index = (values: readonly string[]) =>
    new Map(values.map((v, i) => [v, i]));
  const areaIdx = index(input.areas);
  const kindIdx = index(input.kinds);
  const languages = [...new Set(input.files.map((f) => f.language))].sort();
  const modules = [...new Set(input.files.map((f) => f.module))].sort();
  const langIdx = index(languages);
  const modIdx = index(modules);
  const lookup = (m: Map<string, number>, v: string, dim: string): number => {
    const i = m.get(v);
    if (i === undefined) throw new CodeStatsError(`unknown ${dim} "${v}"`);
    return i;
  };
  return {
    generatedAt: input.generatedAt,
    repository: input.repository,
    commit: input.commit,
    branch: input.branch,
    areas: [...input.areas],
    areaDescriptions: input.areaDescriptions,
    defaultArea: input.defaultArea,
    kinds: [...input.kinds],
    languages,
    modules,
    vendoredExcluded: input.vendoredExcluded,
    includeVendored: input.includeVendored,
    missingFromWorkingTree: input.missing,
    conventions: [...input.conventions],
    files: input.files.map((f) => [
      f.path,
      lookup(areaIdx, f.area, "area"),
      lookup(kindIdx, f.kind, "kind"),
      lookup(langIdx, f.language, "language"),
      lookup(modIdx, f.module, "module"),
      f.bytes,
      f.rawLines,
      f.codeLines,
      f.commentLines,
      f.blankLines,
      f.areaMatched ? 0 : 1,
    ]),
  };
}

/** JSON safe to inline in a <script> element (no `</script>` or `<!--` breakouts). */
export function toInlineJson(value: unknown): string {
  // The payload sits in a type=application/json block read with JSON.parse,
  // so only HTML-parser breakouts matter: escaping `<` covers both.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The report for `input`; refuses a template without exactly one data placeholder. */
export function renderHtmlReport(
  input: HtmlReportInput,
  template = readFileSync(TEMPLATE, "utf8"),
): string {
  const at = template.indexOf(DATA_PLACEHOLDER);
  if (at < 0 || template.indexOf(DATA_PLACEHOLDER, at + 1) >= 0)
    throw new CodeStatsError(
      "the report template must contain the data placeholder exactly once",
    );
  // Slice rather than String#replace: the JSON may hold `$&`-style tokens.
  return (
    template.slice(0, at) +
    toInlineJson(encodeReport(input)) +
    template.slice(at + DATA_PLACEHOLDER.length)
  );
}
