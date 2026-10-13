/**
 * The data a sheet embeds: the report source, the record, the
 * configuration-fit report and the prior record, exactly as they were read.
 * `report.ts extract` prints it, and each part can be written back to a file
 * and rendered again: a record is embedded as JSON, which YAML reads as it
 * is, so `parseRecord` accepts the extracted record unchanged.
 */
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
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
  };
}

/** The embedded block of a sheet, checked for its four parts; their own checks run when they are rendered again. */
export function parseEmbedded(value: unknown): EmbeddedData {
  if (
    !isMapping(value) ||
    value.v !== 1 ||
    !isMapping(value.source) ||
    !isMapping(value.record) ||
    !(value.fit === null || isMapping(value.fit)) ||
    !(value.prior === null || isMapping(value.prior))
  )
    throw new Error(
      "the embedded data is not an audit sheet's: it needs v, source, record, fit and prior",
    );
  return value as unknown as EmbeddedData;
}
