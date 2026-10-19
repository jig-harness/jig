/**
 * The data a sheet embeds: the report source, the record, the
 * configuration-fit report, the prior record and the older records of the
 * trend, exactly as they were read, and the profile it explored when
 * `--profile` named one (render again with the same flags). `report.ts extract` prints it, and each
 * part can be written back to a file and rendered again: a record is embedded
 * as JSON, which YAML reads as it is, so `parseRecord` accepts the extracted
 * record unchanged.
 */
import { isMapping } from "../../../../shared/config-layers.ts";
import { type AuditRecord, declinedData } from "../lib/record.ts";
import type { ReportInput } from "./model.ts";
import { type Fit, type ReportSource, reportFingerprint } from "./source.ts";

/** The id of the block in the page. */
export const DATA_BLOCK_ID = "jig-audit-data";

export interface EmbeddedData {
  v: 1;
  /** The fingerprint of the source's recommendations (`reportFingerprint`). */
  report: string;
  source: ReportSource;
  record: Record<string, unknown>;
  fit: Fit | null;
  prior: Record<string, unknown> | null;
  /** The older records of the trend, in the order they were given. */
  history: Record<string, unknown>[];
  /** The profile and conditional targets `--profile` and `--conditions` named. */
  explored?: { id: string; conditions: string[] };
}

/** A record as plain data, in the shape of the file it came from. */
export function recordData(r: AuditRecord): Record<string, unknown> {
  return {
    version: r.version,
    plugin_version: r.plugin_version,
    date: r.date,
    commit: r.commit,
    ...(r.shape ? { shape: r.shape } : {}),
    ...(r.profile ? { profile: r.profile } : {}),
    ...(r.profile_conditions
      ? { profile_conditions: r.profile_conditions }
      : {}),
    ...(r.heading_to ? { heading_to: r.heading_to } : {}),
    criteria: Object.fromEntries(r.criteria),
    declined: r.declined.map(declinedData),
  };
}

export function embeddedData(input: ReportInput): EmbeddedData {
  return {
    v: 1,
    report: reportFingerprint(input.source.recommendations),
    source: input.source,
    record: recordData(input.record),
    fit: input.fit,
    prior: input.prior ? recordData(input.prior) : null,
    history: input.history.map(recordData),
    ...(input.explored ? { explored: input.explored } : {}),
  };
}

/** The history of an embedded block; a sheet rendered without one has none. Null when it is not a list of records. */
function historyOf(value: unknown): Record<string, unknown>[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(isMapping) ? value : null;
}

/** The embedded block of a sheet, checked for its parts; their own checks run when they are rendered again. */
export function parseEmbedded(value: unknown): EmbeddedData {
  const history = isMapping(value) ? historyOf(value.history) : null;
  if (
    !isMapping(value) ||
    value.v !== 1 ||
    !isMapping(value.source) ||
    !isMapping(value.record) ||
    !(value.fit === null || isMapping(value.fit)) ||
    !(value.prior === null || isMapping(value.prior)) ||
    history === null
  )
    throw new Error(
      "the embedded data is not an audit sheet's: it needs v, source, record, fit, prior and a list of history records",
    );
  return { ...(value as unknown as EmbeddedData), history };
}
