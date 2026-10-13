/**
 * The audit sheet's test inputs: the execa calibration record, the report
 * source and fit report written from that run, and ways to vary the record
 * (a profile, a heading-to profile, a declined entry) without copying it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../resolve-review-comments/scripts/lib/config-layers.ts";
import { loadModules } from "../scripts/lib/criteria.ts";
import { loadProfiles } from "../scripts/lib/profiles.ts";
import { parseRecord } from "../scripts/lib/record.ts";
import { loadSchema } from "../scripts/lib/schema.ts";
import type { ReportInput } from "../scripts/report/model.ts";
import { parseFit, parseReportSource } from "../scripts/report/source.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "report");
export const SOURCE_PATH = join(FIXTURES, "execa.report.json");
export const FIT_PATH = join(FIXTURES, "execa.fit.json");
export const RECORD_PATH = join(
  import.meta.dir,
  "..",
  "calibration",
  "2026-10-12-execa.jig-audit.yaml",
);

const RECORD_TEXT = readFileSync(RECORD_PATH, "utf8");
export const COMMIT = "63ddae6aeb6934da06fdb3754647791e58cd87c3";

/** The report source as raw JSON, for a test to change before parsing. */
export function rawSource(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  if (!isMapping(value)) throw new Error(`${SOURCE_PATH}: not an object`);
  return value;
}

/** The record with extra top-level lines after `shape:`, and the declined list replaced. */
export function recordText(
  extra: string[] = [],
  declined?: string,
  text = RECORD_TEXT,
): string {
  let out = text.replace(
    /^shape: library$/m,
    ["shape: library", ...extra].join("\n"),
  );
  if (declined !== undefined)
    out = out.replace(/^declined: \[\]$/m, `declined:\n${declined}`);
  return out;
}

/**
 * The calibration record as an audit of an earlier day would have written it:
 * another date, commit and plugin version, and the scores `scores` names in
 * place of the record's.
 */
export function recordAt(
  date: string,
  scores: Record<string, string> = {},
  version = "0.14.0",
): string {
  let text = RECORD_TEXT.replace('date: "2026-10-12"', `date: "${date}"`)
    .replace("plugin_version: 0.15.0", `plugin_version: ${version}`)
    .replace(COMMIT, `${date.replaceAll("-", "")}${COMMIT.slice(8)}`);
  for (const [key, score] of Object.entries(scores))
    text = text.replace(
      new RegExp(`(${key}:[^\\n]*\\n(?:\\s+#[^\\n]*\\n)*\\s+score:) \\S+`),
      `$1 ${score}`,
    );
  return text;
}

/** An older record of the same repository: CI was not running the gates then. */
export const priorRecord = (): string =>
  recordAt("2026-07-19", { "M1/gate-set-documented": "absent" });

/** An older record still: the library had not yet ruled out derived files, so M2 attained nothing. */
export const historyRecord = (): string =>
  recordAt("2026-04-02", {
    "M1/gate-set-documented": "absent",
    "M2/derived-inventory-exists": "absent",
  });

const modules = loadModules();
const profiles = loadProfiles(modules);
const schema = loadSchema();

export interface InputOptions {
  record?: string;
  source?: (s: Record<string, unknown>) => void;
  fit?: boolean;
  /** Findings to use in place of the fit report's own. */
  fitFindings?: { id: string; severity: string; message: string }[];
  prior?: string | null;
  /** Older records' text, for the trend. */
  history?: string[];
  today?: string;
}

/** A sheet's input from the fixtures, varied by `o`. */
function fitWith(findings: InputOptions["fitFindings"]) {
  const raw: unknown = JSON.parse(readFileSync(FIT_PATH, "utf8"));
  if (!isMapping(raw)) throw new Error(`${FIT_PATH}: not an object`);
  return parseFit(findings ? { ...raw, findings } : raw, FIT_PATH);
}

export function reportInput(o: InputOptions = {}): ReportInput {
  const raw = rawSource();
  o.source?.(raw);
  return {
    source: parseReportSource(raw),
    record: parseRecord(o.record ?? RECORD_TEXT, "record.yaml"),
    fit: o.fit === false ? null : fitWith(o.fitFindings),
    prior: o.prior ? parseRecord(o.prior, "prior.yaml") : null,
    history: (o.history ?? []).map((h, i) =>
      parseRecord(h, `history-${i}.yaml`),
    ),
    modules,
    profiles,
    schema,
    today: o.today ?? "2026-10-13",
  };
}

/** Remove the suggested profile from a source. */
export const noProfile = (s: Record<string, unknown>) => {
  delete s.profile;
};
