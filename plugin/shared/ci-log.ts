/**
 * The error lines of a failed CI run's log, sorted into categories in the
 * order they should be fixed. `fix-ci`'s `parse-ci-log.ts` prints this
 * reading, and `ci-infra.ts` reads the same entries to tell a failure of the
 * code from one of the infrastructure, so both judge a log by one set of
 * patterns.
 */

export type Category =
  | "schema_drift"
  | "build_error"
  | "drift_check"
  | "typescript"
  | "biome_lint"
  | "test_failure"
  | "gate_failure"
  | "process_exit";

export interface CiError {
  category: Category;
  /** The job that printed the line, from gh's log prefix. */
  job?: string;
  /** The step that printed the line, from gh's log prefix. */
  step?: string;
  raw: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  rule?: string;
  message?: string;
}

export interface ParseResult {
  run_id: string;
  errors_found: number;
  summary: Partial<Record<Category, number>>;
  files_affected: string[];
  errors: CiError[];
}

/** Fix order: a stale schema or a missing module causes errors further down. */
export const PRIORITY: Record<Category, number> = {
  schema_drift: 0,
  build_error: 1,
  drift_check: 2,
  typescript: 3,
  biome_lint: 4,
  test_failure: 5,
  gate_failure: 6,
  process_exit: 7,
};

/**
 * Line patterns, tried in order; the first that matches a line claims it.
 * The `s` flag lets `.` match any character except the line break the log is
 * split on, and `u` gives case-insensitive matching Unicode case folding.
 */
const PATTERNS: [RegExp, Category][] = [
  // TypeScript compiler: file(line,col): error TSxxxx: message
  [/(\S+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/su, "typescript"],
  // Biome lint: path/file.ts lint/category/rule  message
  [/(\S+\.tsx?)\s+(lint\/\S+)\s+(.+)/su, "biome_lint"],
  // Biome diagnostic with a cross marker. The two characters before `error`
  // are the cross (U+00D7) as it reads when its UTF-8 bytes were decoded as
  // Latin-1, the form it takes in some captured logs.
  [/(\S+\.tsx?):(\d+):(\d+)\s+.*(?:\xc3\x97|error)\s+(.+)/su, "biome_lint"],
  // Test runner: FAIL path/to/file.spec.ts
  [/FAIL\s+(\S+\.(?:spec|test)\.tsx?)/su, "test_failure"],
  // Pytest reports the failing test node after FAILED.
  [/^FAILED\s+(\S+\.py)(?:::.*)?/su, "test_failure"],
  // Package managers report permanent failures without an Actions annotation.
  [/^npm\s+(?:ERR!|error)\s+code\s+(.+)/isu, "gate_failure"],
  // Test assertion: file > suite > ... > test, split on the `>` delimiters in
  // `entryFor` so the message keeps the whole path.
  [/(\S+\.(?:spec|test)\.tsx?)\s+>\s+(.+)/su, "test_failure"],
  [/Cannot find module '([^']+)'/su, "build_error"],
  [/Module not found/su, "build_error"],
  // Database schema drift (an ORM schema or a schema dump checked against
  // migrations).
  [/schema.drift|Schema drift detected|schema:check.*fail/su, "schema_drift"],
  // Generated-artifact drift checks: API specs, type surfaces, error-code
  // registries, generated API clients. Usually fixed by a generate or sync
  // script.
  [
    /(drift detected|out[- ]of[- ]sync|OpenAPI (spec )?drift|type[- ]surface drift|error[- ]code drift|Eden coverage|regenerate the (schema|spec|types|SDK|Eden|OpenAPI)|run [`']?(?:pnpm|npm run|yarn|bun run) [\p{L}\p{N}_:-]+:(generate|sync))/isu,
    "drift_check",
  ],
  // The runner's own note that a step exited nonzero. It accompanies a failed
  // gate and an infrastructure failure (a timeout, a lost runner) alike, so it
  // gets its own category rather than counting as a gate diagnostic.
  [/^##\[error\]Process completed with exit code \d+\.?$/su, "process_exit"],
  // Any other failed check that reports an error annotation (a grep gate, a
  // ratchet, a self-test). Without it such a run would count zero errors and
  // read as a flaky runner. Kept last so a specific category wins.
  [/^\s*(::error|##\[error\]|❌|✗|(?:error|failed):)/isu, "gate_failure"],
];

/**
 * `gh run view --log-failed` prefixes every line with
 * `<job>\t<step>\t<ISO-timestamp> `; stripping it lets anchored patterns and
 * the captured `raw` text work on the real content.
 */
const LOG_PREFIX = /^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/su;

/** The job and step named in a stripped prefix, when it has both fields. */
function provenance(prefix: string): { job?: string; step?: string } {
  const fields = prefix.split("\t");
  if (fields.length < 3) return {};
  return { job: fields[0] as string, step: fields[1] as string };
}

/** The first `n` characters, counted in code points rather than UTF-16 units. */
export function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Code-point order, so sorting agrees for characters outside the BMP. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  const at = x.findIndex((point, i) => point !== y[i]);
  if (at === -1 || at >= y.length) return x.length - y.length;
  return (x[at] ?? 0) - (y[at] ?? 0);
}

function entryFor(
  category: Category,
  origin: { job?: string; step?: string },
  line: string,
  groups: (string | undefined)[],
  rawLimit: number,
): CiError {
  const entry: CiError = { category, ...origin, raw: head(line, rawLimit) };
  const g = (i: number) => groups[i] ?? "";
  switch (category) {
    case "typescript":
      entry.file = g(0);
      entry.line = Number.parseInt(g(1), 10);
      entry.column = Number.parseInt(g(2), 10);
      entry.code = g(3);
      entry.message = g(4).trim();
      break;
    case "biome_lint":
      entry.file = g(0);
      entry.rule = g(1).includes("/") ? g(1) : "";
      entry.message = g(groups.length - 1).trim();
      break;
    case "test_failure":
      entry.file = g(0);
      entry.message =
        groups.length > 1
          ? g(1)
              .split(/\s+>\s+/u)
              .map((part) => part.trim())
              .join(" > ")
          : "";
      break;
    case "schema_drift":
      entry.message =
        "Schema drift detected - regenerate the schema (fix_ci.regenerate_commands)";
      break;
    default:
      // build_error, drift_check, gate_failure, process_exit: the line itself
      // says it best.
      entry.message = head(line, 200);
  }
  return entry;
}

/** The entry the first pattern that matches `rawLine` makes of it, with its key; `null` when none does. */
function lineEntry(
  rawLine: string,
  rawLimit: number,
): { entry: CiError; key: string } | null {
  const trimmed = rawLine.trim();
  const origin = provenance(LOG_PREFIX.exec(trimmed)?.[0] ?? "");
  const line = trimmed.replace(LOG_PREFIX, "").trim();
  if (line === "") return null;
  for (const [pattern, category] of PATTERNS) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const entry = entryFor(category, origin, line, match.slice(1), rawLimit);
    // The whole line, not the possibly truncated or constant `message`, and
    // the step that printed it, so only a repeat of the same diagnostic from
    // the same step collapses: two steps' identical exit notes stay apart.
    const key = JSON.stringify([
      entry.category,
      entry.job ?? null,
      entry.step ?? null,
      entry.file ?? null,
      entry.line ?? null,
      entry.column ?? null,
      entry.code ?? null,
      entry.rule ?? null,
      line,
    ]);
    return { entry, key };
  }
  return null;
}

/** Categorize every error line in a failed run's log. */
export function parseCiErrors(
  logContent: string,
  runId = "",
  rawLimit = 200,
): ParseResult {
  const byKey = new Map<string, CiError>();
  for (const rawLine of logContent.replace(/\r\n?/g, "\n").split("\n")) {
    const found = lineEntry(rawLine, rawLimit);
    if (found !== null && !byKey.has(found.key))
      byKey.set(found.key, found.entry);
  }
  const errors = [...byKey.values()].sort(
    (a, b) => PRIORITY[a.category] - PRIORITY[b.category],
  );
  const summary: Partial<Record<Category, number>> = {};
  for (const e of errors) summary[e.category] = (summary[e.category] ?? 0) + 1;
  const files = [
    ...new Set(errors.map((e) => e.file ?? "").filter((f) => f !== "")),
  ].sort(byCodePoint);
  return {
    run_id: runId,
    errors_found: errors.length,
    summary,
    files_affected: files,
    errors,
  };
}
